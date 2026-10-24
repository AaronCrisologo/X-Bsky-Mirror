const { BEARER_TOKEN } = require('./config');
const { ghaEndGroup, ghaError, ghaGroup, log } = require('./log');

// ─── Cookie / env validation ──────────────────────────────────────────────────

function validateEnv() {
    ghaGroup('[AUTH] Environment Validation');
    const authToken = process.env.X_AUTH_TOKEN;
    const ct0 = process.env.X_CT0;
    let valid = true;

    if (!authToken) {
        ghaError('X_AUTH_TOKEN secret is missing or empty');
        valid = false;
    } else {
        log('[OK]', 'ENV', `X_AUTH_TOKEN present (length: ${authToken.length})`);
    }

    if (!ct0) {
        ghaError('X_CT0 secret is missing or empty');
        valid = false;
    } else {
        log('[OK]', 'ENV', `X_CT0 present (length: ${ct0.length})`);
    }

    ghaEndGroup();
    return valid;
}

function getAuthHeaders(ct0) {
    return {
        'authorization': `Bearer ${BEARER_TOKEN}`,
        'x-csrf-token': ct0,
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes',
        'x-twitter-client-language': 'en',
        'cookie': `auth_token=${process.env.X_AUTH_TOKEN}; ct0=${ct0}`,
    };
}

module.exports = {
    validateEnv,
    getAuthHeaders,
};
