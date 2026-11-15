import type { ReactNode } from 'react';

/** Test-server-only Auth0 replacement. The normal Vite config never aliases this module. */
export function Auth0Provider({ children }: { children: ReactNode }) {
  return children;
}

const getAccessTokenSilently = async () => 'synthetic-e2e-token';
const loginWithRedirect = async () => undefined;
const logout = async () => undefined;

export function useAuth0() {
  const role = new URL(window.location.href).searchParams.get('e2e-role') === 'reader' ? 'reader' : 'operator';
  return {
    isAuthenticated: true,
    isLoading: false,
    user: { sub: `synthetic-e2e|${role}` },
    error: undefined,
    getAccessTokenSilently,
    loginWithRedirect,
    logout,
  };
}
