import { ConfigurationError, parseRuntimeConfig, type RuntimeConfig } from './oidc-config';

/**
 * Loads the public runtime configuration that the deployment serves beside the application. Because it is read at startup, the same
 * build can be promoted between environments by changing configuration, not by rebuilding. The response is never cached.
 */
export const RUNTIME_CONFIG_PATH = '/config.json';

export async function loadRuntimeConfig(fetchImpl: typeof fetch = fetch): Promise<RuntimeConfig> {
  let response: Response;
  try {
    response = await fetchImpl(RUNTIME_CONFIG_PATH, { cache: 'no-store', credentials: 'omit', redirect: 'error' });
  } catch {
    throw new ConfigurationError('Runtime configuration could not be loaded.');
  }
  if (!response.ok) throw new ConfigurationError('Runtime configuration is unavailable.');
  return parseRuntimeConfig(await response.json());
}
