// @ts-check
const core = require('@actions/core');
const command = require('@actions/core/lib/command');
const got = require('got').default;
const jsonata = require('jsonata');
module.exports = {};
const wildcard = '*';
module.exports.wildcard = wildcard;

/**
 * Replaces any dot chars to __ and removes non-ascii charts
 * @param {string} dataKey
 * @param {boolean=} isEnvVar
 */
function normalizeOutputKey(dataKey, isEnvVar = false) {
    let outputKey = dataKey
        .replace('.', '__').replace(new RegExp('-', 'g'), '').replace(/[^\p{L}\p{N}_-]/gu, '');
    if (isEnvVar) {
        outputKey = outputKey.toUpperCase();
    }
    core.debug(`Output key for dataKey ${dataKey}, isEnvVar ${isEnvVar} gives ${outputKey}`)
    return outputKey;
}
module.exports.normalizeOutputKey = normalizeOutputKey;

const { auth: { retrieveToken }, secrets: { getSecrets } } = require('./index');

const AUTH_METHODS = ['approle', 'token', 'github', 'jwt', 'kubernetes'];

async function exportSecrets() {
    const vaultUrl = core.getInput('url', { required: true });
    const vaultNamespace = core.getInput('namespace', { required: false });
    const extraHeaders = parseHeadersInput('extraHeaders', { required: false });
    const exportEnv = core.getInput('exportEnv', { required: false }) != 'false';
    const exportToken = (core.getInput('exportToken', { required: false }) || 'false').toLowerCase() != 'false';

    const secretsInput = core.getInput('secrets', { required: false });
    const secretRequests = parseSecretsInput(secretsInput);
    const skipMasksLine = core.getInput('skipMasks', { required: false });
    var skipMasks = [];
    if (skipMasksLine != null) {
        skipMasks = skipMasksLine.split(",");
    }

    const vaultMethod = (core.getInput('method', { required: false }) || 'token').toLowerCase();
    const authPayload = core.getInput('authPayload', { required: false });
    if (!AUTH_METHODS.includes(vaultMethod) && !authPayload) {
        throw Error(`Sorry, the provided authentication method ${vaultMethod} is not currently supported and no custom authPayload was provided.`);
    }

    const defaultOptions = {
        prefixUrl: vaultUrl,
        headers: {},
        https: {}
    }

    const tlsSkipVerify = (core.getInput('tlsSkipVerify', { required: false }) || 'false').toLowerCase() != 'false';
    if (tlsSkipVerify === true) {
        defaultOptions.https.rejectUnauthorized = false;
    }

    const caCertificateRaw = core.getInput('caCertificate', { required: false });
    if (caCertificateRaw != null) {
        defaultOptions.https.certificateAuthority = Buffer.from(caCertificateRaw, 'base64').toString();
    }

    const clientCertificateRaw = core.getInput('clientCertificate', { required: false });
    if (clientCertificateRaw != null) {
	    defaultOptions.https.certificate = Buffer.from(clientCertificateRaw, 'base64').toString();
    }

    const clientKeyRaw = core.getInput('clientKey', { required: false });
    if (clientKeyRaw != null) {
	    defaultOptions.https.key = Buffer.from(clientKeyRaw, 'base64').toString();
    }

    for (const [headerName, headerValue] of extraHeaders) {
        defaultOptions.headers[headerName] = headerValue;
    }

    if (vaultNamespace != null) {
        defaultOptions.headers["X-Vault-Namespace"] = vaultNamespace;
    }

    const vaultToken = await retrieveToken(vaultMethod, got.extend(defaultOptions));
    defaultOptions.headers['X-Vault-Token'] = vaultToken;
    const client = got.extend(defaultOptions);

    if (exportToken === true) {
        command.issue('add-mask', vaultToken);
        core.exportVariable('VAULT_TOKEN', `${vaultToken}`);
    }

    const requests = secretRequests.map(request => {
        const { path, selector } = request;
        return request;
    });

    const results = await getSecrets(requests, client);

    for (const result of results) {
        var { value, request, cachedResponse } = result;
        if (cachedResponse) {
            core.debug('ℹ using cached response');
        }
        for (const line of value.replace(/\r/g, '').split('\n')) {
            if (line.length > 0) {
                if (skipMasks.includes(request.outputVarName)) {
                    core.debug(`Not masking ${request.outputVarName}`)
                } else {
                    core.debug(`Masking ${request.outputVarName}`)
                    command.issue('add-mask', line);
                }
            }
        }
        if (exportEnv) {
            core.exportVariable(request.envVarName, `${value}`);
        }
        core.setOutput(request.outputVarName, `${value}`);
        core.debug(`✔ ${request.path} => outputs.${request.outputVarName}${exportEnv ? ` | env.${request.envVarName}` : ''}`);
    }
};
module.exports.exportSecrets = exportSecrets;

/** @typedef {Object} SecretRequest 
 * @property {string} path
 * @property {string} envVarName
 * @property {string} outputVarName
 * @property {string} selector
*/

/**
 * Parses a secrets input string into key paths and their resulting environment variable name.
 * @param {string} secretsInput
 */
function parseSecretsInput(secretsInput) {
    if (!secretsInput) {
      return []
    }

    const secrets = secretsInput
        .split(';')
        .filter(key => !!key)
        .map(key => key.trim())
        .filter(key => key.length !== 0);

    /** @type {SecretRequest[]} */
    const output = [];
    for (const secret of secrets) {
        let pathSpec = secret;
        let outputVarNameOrPrefix = null;

        const renameSigilIndex = secret.lastIndexOf('|');
        if (renameSigilIndex > -1) {
            pathSpec = secret.substring(0, renameSigilIndex).trim();
            outputVarNameOrPrefix = secret.substring(renameSigilIndex + 1).trim();

            if (outputVarNameOrPrefix.length < 1) {
                throw Error(`You must provide a value when mapping a secret to a name. Input: "${secret}"`);
            }
        }

        const pathParts = pathSpec
            .split(/\s+/)
            .map(part => part.trim())
            .filter(part => part.length !== 0);

        if (pathParts.length !== 2) {
            throw Error(`You must provide a valid path and key. Input: "${secret}"`);
        }

        const [path, selectorQuoted] = pathParts;

        /** @type {any} */
        const selectorAst = jsonata(selectorQuoted).ast();
        const selector = selectorQuoted.replace(new RegExp('"', 'g'), '');
        if (selector !== wildcard && (selectorAst.type !== "path" || selectorAst.steps[0].stages) && selectorAst.type !== "string" && !outputVarNameOrPrefix) {
            throw Error(`You must provide a name for the output key when using json selectors. Input: "${secret}". Selector "${selector}". Wildard is "${wildcard}`);
        }

        let prefix = ''
        let envVarName = outputVarNameOrPrefix;

        if (selector === wildcard && outputVarNameOrPrefix) {
            prefix = outputVarNameOrPrefix;
        }

        if (!outputVarNameOrPrefix || selector === wildcard) {
            outputVarNameOrPrefix = normalizeOutputKey(`${prefix}${selector}`);
            envVarName = normalizeOutputKey(`${prefix}${selector}`, true);
        }

        core.debug(`Path "${path}" with selector "${selector}" gives envVar "${envVarName}" and outputVar "${outputVarNameOrPrefix}"`)
        output.push({
            path,
            envVarName,
            outputVarName: outputVarNameOrPrefix,
            selector
        });
    }
    return output;
}
module.exports.parseSecretsInput = parseSecretsInput;

/**
 * @param {string} inputKey
 * @param {any} inputOptions
 */
function parseHeadersInput(inputKey, inputOptions) {
    /** @type {string}*/
    const rawHeadersString = core.getInput(inputKey, inputOptions) || '';
    const headerStrings = rawHeadersString
        .split('\n')
        .map(line => line.trim())
        .filter(line => line !== '');
    return headerStrings
        .reduce((map, line) => {
            const seperator = line.indexOf(':');
            const key = line.substring(0, seperator).trim().toLowerCase();
            const value = line.substring(seperator + 1).trim();
            if (map.has(key)) {
                map.set(key, [map.get(key), value].join(', '));
            } else {
                map.set(key, value);
            }
            return map;
        }, new Map());
}
module.exports.parseHeadersInput = parseHeadersInput;

