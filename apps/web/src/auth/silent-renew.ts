import { UserManager } from 'oidc-client-ts';
import { loadRuntimeConfig } from './runtime-config';
import { userManagerSettings } from './oidc-config';

// Runs inside the hidden frame that the session uses for prompt=none renewal. It only returns the authorisation response to the parent
// window. Tokens are never handled here: the library validates state and nonce and passes the result to the parent.
loadRuntimeConfig()
  .then((config) => {
    if (config.oidc) void new UserManager(userManagerSettings(config.oidc, window.location.origin)).signinSilentCallback();
  })
  .catch(() => undefined);
