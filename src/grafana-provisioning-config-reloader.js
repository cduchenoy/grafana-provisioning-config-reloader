import fs from 'node:fs'
import pino from 'pino'
import chokidar from 'chokidar'
import debounce from 'debounce'
import picomatch from 'picomatch'
import pRetry from 'p-retry';
import pinoPretty from 'pino-pretty'

// Grafana environment variables
const GF_SERVER_ROOT_URL = process.env['GF_SERVER_ROOT_URL'] || 'http://localhost:3000'
const GF_SECURITY_ADMIN_USER = process.env['GF_SECURITY_ADMIN_USER'] || 'grafana'
const GF_SECURITY_ADMIN_PASSWORD = (() => {
    const file = process.env['GF_SECURITY_ADMIN_PASSWORD__FILE']
    if (file) return fs.readFileSync(file, 'utf8').trim()
    return process.env['GF_SECURITY_ADMIN_PASSWORD'] || 'grafana'
})()
const GF_PATHS_PROVISIONING = process.env['GF_PATHS_PROVISIONING'] || '/etc/grafana/provisioning'

// gf-provisioning-config-reloader
/**
 * Possible values: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent"
 */
const GRAFANA_PROVISIONING_CONFIG_RELOADER_LOG_LEVEL = process.env['GRAFANA_PROVISIONING_CONFIG_RELOADER_LOG_LEVEL'] || 'info'
const GRAFANA_PROVISIONING_CONFIG_RELOADER_ALERTING_ENABLED = process.env['GRAFANA_PROVISIONING_CONFIG_RELOADER_ALERTING_ENABLED'] || 'true'
const GRAFANA_PROVISIONING_CONFIG_RELOADER_DASHBOARD_ENABLED = process.env['GRAFANA_PROVISIONING_CONFIG_RELOADER_DASHBOARD_ENABLED'] || 'true'
const GRAFANA_PROVISIONING_CONFIG_RELOADER_DATASOURCE_ENABLED = process.env['GRAFANA_PROVISIONING_CONFIG_RELOADER_DATASOURCE_ENABLED'] || 'true'

/**
 * Send a request to the Grafana API
 * @param {string} path
 * @param {RequestInit} opts
 * @returns
 */
function request(path, opts = {}) {
    const headers = new Headers(opts.headers)
    delete opts.headers
    if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json')
    }
    if (!headers.has('Authorization')) {
        headers.set('Authorization', `Basic ${btoa(`${GF_SECURITY_ADMIN_USER}:${GF_SECURITY_ADMIN_PASSWORD}`)}`)
    }
    return fetch(`${GF_SERVER_ROOT_URL}/api/${path}`, { headers, ...opts })
}

/**
 * Send a POST request to the Grafana API
 * @param {string} path
 * @param {Record<any, any>} data
 * @param {RequestInit} opts
 * @returns
 */
function write(path, data, opts = {}) {
    return request(path, {
        method: 'POST',
        body: JSON.stringify(data),
        ...opts,
    }).then(async res => {
        const json = await res.json()
        if (res.status !== 200) {
            throw new Error(`(${res.statusText}) ${json.message}`)
        }
        return json
    })
}

function sleep(ms = 0) {
    return new Promise(resolve => setTimeout(resolve, ms * 1000))
}

// Wait for Grafana to be ready
function waitforgrafana() {
    logger.info('Waiting for Grafana to be ready...')
    return pRetry(async () => {
        const response = await fetch(`${GF_SERVER_ROOT_URL}/api/health`)
        if (response.status !== 200) {
            throw new Error(`Grafana health check returned HTTP ${response.status}`)
        }
        const json = await response.json()
        if (json.database !== "ok") {
            throw new Error(`Grafana database not ready: ${json.database}`)
        }
    }, {
        retries: 11,
        minTimeout: 5000,
        maxTimeout: 5000,
        onFailedAttempt: error => {
            logger.info(`Grafana health check attempt ${error.attemptNumber} failed (${error.message}). There are ${error.retriesLeft} retries left.`);
        },
    })
}

// Create a matcher for dashboards and datasources
const provisioningAlertingMatcher = picomatch('**/alerting/*')
const provisioningDashboardsMatcher = picomatch('**/dashboards/*')
const provisioningDatasourcesMatcher = picomatch('**/datasources/*')

// Structured logging
const logger = pino({
    level: GRAFANA_PROVISIONING_CONFIG_RELOADER_LOG_LEVEL,
    timestamp: false,
}, pinoPretty({ colorize: false, singleLine: true }))

async function main() {
    logger.info('Starting Grafana provisioning config reloader...')

    Promise.resolve()
        .then(() => sleep(15))
        .then(() => waitforgrafana())
        .then(() => {
            const reloadAlerting = debounce(function (event, path) {
                if (GRAFANA_PROVISIONING_CONFIG_RELOADER_ALERTING_ENABLED !== 'true') { return }
                write('admin/provisioning/alerting/reload', {})
                    .then(res => logger.info(res.message))
                    .catch(err => logger.warn(err))
            }, 2000)
            const reloadDashboards = debounce(function () {
                if (GRAFANA_PROVISIONING_CONFIG_RELOADER_DASHBOARD_ENABLED !== 'true') { return }
                write('admin/provisioning/dashboards/reload', {})
                    .then(res => logger.info(res.message))
                    .catch(err => logger.warn(err))
            }, 2000)
            const reloadDatasources = debounce(function () {
                if (GRAFANA_PROVISIONING_CONFIG_RELOADER_DATASOURCE_ENABLED !== 'true') { return }
                write('admin/provisioning/datasources/reload', {})
                    .then(res => {
                        logger.info(res.message)
                        // Dashboards depend on datasources — always reload after datasources
                        reloadDashboards()
                    })
                    .catch(err => logger.warn(err))
            }, 2000)

            // Verify datasources are provisioned; retry reload if the provider hasn't written
            // the file yet (race condition on first deployment — provider may lag behind).
            const verifyDatasources = async () => {
                const VERIFY_ATTEMPTS = 5
                const VERIFY_DELAY_S = 10
                for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++) {
                    await sleep(5)
                    const resp = await request('datasources')
                    const ds = await resp.json()
                    if (Array.isArray(ds) && ds.length > 0) {
                        logger.info(`Datasource verification OK: ${ds.length} datasource(s) provisioned`)
                        return
                    }
                    logger.info(`No datasources found after reload (attempt ${attempt}/${VERIFY_ATTEMPTS}), retrying in ${VERIFY_DELAY_S}s...`)
                    if (attempt < VERIFY_ATTEMPTS) {
                        await sleep(VERIFY_DELAY_S)
                        reloadDatasources()
                    }
                }
                logger.warn('Datasource verification: no datasources provisioned after all attempts')
            }

            // Trigger a reload: datasources first, dashboards will follow after datasource reload succeeds.
            // If datasources are disabled, reload dashboards directly.
            logger.info("Trigger a reload of the provisioning configuration")
            reloadAlerting()
            if (GRAFANA_PROVISIONING_CONFIG_RELOADER_DATASOURCE_ENABLED === 'true') {
                reloadDatasources()
                verifyDatasources().catch(err => logger.warn({ err }, 'Datasource verification failed'))
            } else {
                reloadDashboards()
            }

            // Monitor provisioning directory for changes to dashboards and datasources,
            // then reload the provisioned configuration via the Grafana API
            logger.info(`Start watching provisioning directory "${GF_PATHS_PROVISIONING}"...`)
            chokidar.watch(GF_PATHS_PROVISIONING).on('all', (event, path) => {
                logger.debug({ event, path }, "Event triggered")
                if (provisioningAlertingMatcher(path))    { reloadAlerting(event, path)   }
                if (provisioningDashboardsMatcher(path))  { reloadDashboards(event, path)  }
                if (provisioningDatasourcesMatcher(path)) { reloadDatasources(event, path) }
            })
        })
        .catch((err) => {
            logger.error(err)
            process.exit(1)
        })

    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => {
            logger.info(`Received signal: ${signal}, exiting...`)
            process.exit(0)
        })
    }

}

main()
