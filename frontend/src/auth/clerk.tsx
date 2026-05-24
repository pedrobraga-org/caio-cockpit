"use client";

// NOTE: We intentionally keep this file very small and dependency-free.
// It provides CI/secretless-build safe fallbacks for Clerk hooks/components.

import type { ReactNode, ComponentProps } from "react";

import {
  ClerkProvider,
  SignedIn as ClerkSignedIn,
  SignedOut as ClerkSignedOut,
  SignInButton as ClerkSignInButton,
  SignOutButton as ClerkSignOutButton,
  useAuth as clerkUseAuth,
  useUser as clerkUseUser,
} from "@clerk/nextjs";

import { isLikelyValidClerkPublishableKey } from "@/auth/clerkKey";
import { getLocalAuthToken, isLocalAuthMode } from "@/auth/localAuth";
import { isCfAccessMode } from "@/auth/mode";

function hasLocalAuthToken(): boolean {
  return Boolean(getLocalAuthToken());
}

export function isClerkEnabled(): boolean {
  // IMPORTANT: keep this in sync with AuthProvider; otherwise components like
  // <SignedOut/> may render without a <ClerkProvider/> and crash during prerender.
  if (isCfAccessMode()) return false;
  if (isLocalAuthMode()) return false;
  return isLikelyValidClerkPublishableKey(
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  );
}

export function SignedIn(props: { children: ReactNode }) {
  // In cf_access mode, reaching the SPA at all means CF Access has already
  // authenticated the user at the edge — treat as signed in.
  if (isCfAccessMode()) return <>{props.children}</>;
  if (isLocalAuthMode()) {
    return hasLocalAuthToken() ? <>{props.children}</> : null;
  }
  if (!isClerkEnabled()) return null;
  return <ClerkSignedIn>{props.children}</ClerkSignedIn>;
}

export function SignedOut(props: { children: ReactNode }) {
  if (isCfAccessMode()) return null;
  if (isLocalAuthMode()) {
    return hasLocalAuthToken() ? null : <>{props.children}</>;
  }
  if (!isClerkEnabled()) return <>{props.children}</>;
  return <ClerkSignedOut>{props.children}</ClerkSignedOut>;
}

// Keep the same prop surface as Clerk components so call sites don't need edits.
export function SignInButton(props: ComponentProps<typeof ClerkSignInButton>) {
  if (!isClerkEnabled()) return null;
  return <ClerkSignInButton {...props} />;
}

export function SignOutButton(
  props: ComponentProps<typeof ClerkSignOutButton>,
) {
  if (!isClerkEnabled()) return null;
  return <ClerkSignOutButton {...props} />;
}

export function useUser() {
  if (isCfAccessMode()) {
    return { isLoaded: true, isSignedIn: true, user: null } as const;
  }
  if (isLocalAuthMode()) {
    return {
      isLoaded: true,
      isSignedIn: hasLocalAuthToken(),
      user: null,
    } as const;
  }
  if (!isClerkEnabled()) {
    return { isLoaded: true, isSignedIn: false, user: null } as const;
  }
  return clerkUseUser();
}

export function useAuth() {
  if (isCfAccessMode()) {
    return {
      isLoaded: true,
      isSignedIn: true,
      userId: "cf-access-user",
      sessionId: "cf-access-session",
      getToken: async () => null,
    } as const;
  }
  if (isLocalAuthMode()) {
    const token = getLocalAuthToken();
    return {
      isLoaded: true,
      isSignedIn: Boolean(token),
      userId: token ? "local-user" : null,
      sessionId: token ? "local-session" : null,
      getToken: async () => token,
    } as const;
  }
  if (!isClerkEnabled()) {
    return {
      isLoaded: true,
      isSignedIn: false,
      userId: null,
      sessionId: null,
      getToken: async () => null,
    } as const;
  }
  return clerkUseAuth();
}

// Re-export ClerkProvider for places that want to mount it, but strongly prefer
// gating via isClerkEnabled() at call sites.
export { ClerkProvider };
