import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { AuthProvider, useAuth } from 'react-oidc-context';
import { InMemoryWebStorage, UserManager, WebStorageStateStore } from 'oidc-client-ts';
import { type OidcSettings, userManagerSettings } from './oidc-config';

/**
 * The application's view of the signed-in session. Components depend on this interface and never on a vendor SDK, so a different
 * standards-compliant identity provider is a configuration change.
 *
 * Token storage policy (see docs/WEB-AUTHENTICATION.md): access and refresh tokens live only in memory for the lifetime of the page.
 * The transient PKCE state and nonce needed across the redirect live in sessionStorage (tab-scoped) and are removed when the
 * callback completes. Nothing is written to localStorage, and no token is placed in a URL.
 *
 * The UserManager is created here and passed to the provider, so silent renewal and restore call it directly. The navigator wrappers
 * in the provider record every failure as an application error, which would treat a normal "not signed in" as a fault.
 */

export type SessionStatus = 'loading' | 'anonymous' | 'authenticated' | 'error';
export type SessionErrorKind = 'provider_unavailable' | 'callback_failed' | 'session_expired' | 'sign_in_failed';

export interface Session {
  readonly status: SessionStatus;
  readonly error: SessionErrorKind | null;
  /** Stable subject identifier (`sub`). Used for display and to scope cached UI state, never for authorisation. */
  readonly subject: string | null;
  /** Scopes carried by the current access token, read for UI gating only. The API enforces scope. */
  readonly scopes: readonly string[];
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  /** Returns a valid access token for the API, renewing it if needed. Throws `SessionExpired` when reauthentication is required. */
  getAccessToken(): Promise<string>;
}

export class SessionExpired extends Error {
  constructor() {
    super('Your session has expired. Sign in again to continue.');
    this.name = 'SessionExpired';
  }
}

export class SignInFailure extends Error {
  constructor(readonly kind: SessionErrorKind) {
    super('Sign-in could not be started.');
    this.name = 'SignInFailure';
  }
}

/** The text shown to the user for each failure kind. The kind is named, so the cause is clear without exposing details. */
export function messageFor(kind: SessionErrorKind): string {
  switch (kind) {
    case 'provider_unavailable': return 'The identity provider is unavailable. Try again when it is back.';
    case 'callback_failed': return 'Sign-in could not be completed. Start sign-in again.';
    case 'session_expired': return 'Your session has expired. Sign in again to continue.';
    default: return 'Sign-in could not be completed. Check the identity provider configuration and try again.';
  }
}

const SessionContext = createContext<Session | null>(null);

/** Seconds of margin before expiry at which a token is treated as expired. */
const EXPIRY_MARGIN_SECONDS = 30;

function scopesOf(accessToken: string | undefined): string[] {
  if (!accessToken) return [];
  try {
    const payload = accessToken.split('.')[1];
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { scope?: unknown };
    return typeof json.scope === 'string' ? json.scope.split(' ').filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** Classifies a library error. The library's errors are plain objects, so the name and message are read rather than instanceof checks. */
export function classifyError(error: unknown): SessionErrorKind {
  const name = typeof (error as { name?: unknown })?.name === 'string' ? (error as { name: string }).name : '';
  const message = typeof (error as { message?: unknown })?.message === 'string' ? (error as { message: string }).message : '';
  if (/state|nonce|code verifier|pkce|no matching/i.test(message)) return 'callback_failed';
  if (name === 'TypeError' || /fetch|network|discovery|failed to load|timed? ?out|unavailable|ECONN/i.test(message)) return 'provider_unavailable';
  return 'sign_in_failed';
}

/** True when the address bar holds an authorisation response (code or error, with state). */
function hasCallbackParameters(location: Location): boolean {
  const search = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.replace('#', '?'));
  return [search, hash].some((params) => (params.has('code') || params.has('error')) && params.has('state'));
}

function SessionBridge({ userManager, children }: { readonly userManager: UserManager; readonly children: ReactNode }) {
  const auth = useAuth();
  const restoreAttempted = useRef(false);

  const session = useMemo<Session>(() => {
    const user = auth.user;
    const authenticated = auth.isAuthenticated && user !== null && user !== undefined && !user.expired;
    const status: SessionStatus = auth.isLoading ? 'loading'
      : auth.error ? 'error'
        : authenticated ? 'authenticated' : 'anonymous';
    const error = auth.error ? classifyError(auth.error) : null;
    return {
      status,
      error,
      subject: authenticated ? String(user.profile?.sub ?? '') || null : null,
      scopes: authenticated ? scopesOf(user.access_token) : [],
      async signIn() {
        try {
          await userManager.signinRedirect();
        } catch (failure) {
          throw new SignInFailure(classifyError(failure));
        }
      },
      async signOut() {
        // Local state is cleared first, so a failed or unreachable provider still ends the session in this browser.
        await userManager.removeUser();
        try {
          await userManager.signoutRedirect();
        } catch {
          // The redirect is best effort. The local session is already gone.
        }
      },
      async getAccessToken() {
        const current = await userManager.getUser();
        if (current && !current.expired && (current.expires_at ?? 0) - Date.now() / 1000 > EXPIRY_MARGIN_SECONDS) {
          return current.access_token;
        }
        const renewed = await userManager.signinSilent().catch(() => null);
        if (renewed && !renewed.expired) return renewed.access_token;
        await userManager.removeUser();
        throw new SessionExpired();
      },
    };
  }, [auth, userManager]);

  // Remove an authorisation response from the address bar on failure too. A success is cleaned up by the provider's callback.
  useEffect(() => {
    if (auth.error && (window.location.search || window.location.hash)) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, [auth.error]);

  // Restore an existing identity-provider session once, after the provider has initialised. "Not signed in" is a normal outcome.
  useEffect(() => {
    if (auth.isLoading || auth.isAuthenticated || auth.error || restoreAttempted.current) return;
    if (hasCallbackParameters(window.location)) return;
    restoreAttempted.current = true;
    void userManager.signinSilent().catch(() => null);
  }, [auth.isLoading, auth.isAuthenticated, auth.error, userManager]);

  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

/** Wraps the application in the provider-neutral session. Configuration is supplied by the deployment. */
export function SessionProvider({ settings, children }: { readonly settings: OidcSettings; readonly children: ReactNode }) {
  const userManager = useMemo(() => new UserManager({
    ...userManagerSettings(settings, window.location.origin),
    // Tokens stay in memory. Only the transient PKCE state needs sessionStorage, and the library uses it for that by default.
    userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
  }), [settings]);
  return <AuthProvider userManager={userManager} onSigninCallback={() => {
    // Remove the authorisation code and state from the address bar as soon as the callback has been processed.
    window.history.replaceState({}, document.title, window.location.pathname);
  }}>
    <SessionBridge userManager={userManager}>{children}</SessionBridge>
  </AuthProvider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession must be used inside SessionProvider.');
  return session;
}
