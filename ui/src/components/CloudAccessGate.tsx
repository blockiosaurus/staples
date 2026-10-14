import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Navigate, Outlet, useLocation } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { isTemporaryApiError } from "@/api/response";
import { queryKeys } from "@/lib/queryKeys";
import { PRODUCT_NAME } from "@/lib/branding";
import { BootstrapPendingPage } from "@/components/BootstrapPendingPage";
import { PaperclipLoading } from "@/components/AnimatedPaperclipIcon";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CloudSignIn } from "@/components/CloudSignIn";
import { clearCloudSignInAttempt } from "@/lib/cloud-sign-in";
import { useSignOut } from "@/hooks/useSignOut";

const RECONNECT_INTERVAL_MS = 5_000;

export function CloudAccessError({
  temporary,
  retrying,
  onRetry,
}: {
  temporary: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 px-4 py-16">
      <RefreshCw className="size-6 text-muted-foreground" aria-hidden="true" />
      <div className="flex flex-col gap-2" role="status">
        <h1 className="text-xl font-semibold">
          {temporary ? `Reconnecting to ${PRODUCT_NAME}` : `Unable to load ${PRODUCT_NAME}`}
        </h1>
        <p className="text-sm text-muted-foreground">
          {temporary
            ? "The server may be restarting or your connection was interrupted. We’ll try again every few seconds and reconnect automatically."
            : "We couldn’t check your access to this instance. Try again, or contact your instance administrator if this continues."}
        </p>
      </div>
      <div>
        <Button variant="outline" onClick={onRetry} disabled={retrying}>
          {retrying ? "Connecting…" : "Try again"}
        </Button>
      </div>
    </div>
  );
}

/**
 * A signed-in account with no company on an instance where only admins create
 * companies. This is an expected state for a new teammate, not an error.
 */
function NoBoardAccessPage() {
  const signOutMutation = useSignOut();
  return (
    <div className="mx-auto max-w-xl px-4 py-10">
      <Card className="block p-6">
        <h1 className="text-xl font-semibold">Ask the person who invited you for access</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          You&apos;re signed in, but this account isn&apos;t part of a company here yet. The person who invited you
          can add you, or send you an invite link to open.
        </p>
        <div className="mt-4">
          <Button variant="outline" onClick={() => signOutMutation.mutate()} disabled={signOutMutation.isPending}>
            {signOutMutation.isPending ? "Signing out..." : "Sign out"}
          </Button>
        </div>
      </Card>
    </div>
  );
}

export function CloudAccessGate({ allowMembershipRequest = false }: { allowMembershipRequest?: boolean } = {}) {
  const location = useLocation();
  const queryClient = useQueryClient();
  const [hasOpenedBoard, setHasOpenedBoard] = useState(false);
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
    refetchInterval: (query) => {
      if (query.state.error) return isTemporaryApiError(query.state.error) ? RECONNECT_INTERVAL_MS : false;
      const data = query.state.data;
      if (data?.status === "starting") return RECONNECT_INTERVAL_MS;
      return data?.deploymentMode === "authenticated" && data.bootstrapStatus === "bootstrap_pending"
        ? 2000
        : false;
    },
    refetchIntervalInBackground: true,
  });

  const isAuthenticatedMode = healthQuery.data?.deploymentMode === "authenticated";
  const isBootstrapPending = isAuthenticatedMode && healthQuery.data?.bootstrapStatus === "bootstrap_pending";
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: isAuthenticatedMode,
    retry: false,
    refetchInterval: (query) => isTemporaryApiError(query.state.error) ? RECONNECT_INTERVAL_MS : false,
    refetchIntervalInBackground: true,
  });

  useEffect(() => {
    if (sessionQuery.data) clearCloudSignInAttempt();
  }, [sessionQuery.data]);

  const boardAccessQuery = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: isAuthenticatedMode && !isBootstrapPending && !!sessionQuery.data,
    retry: false,
    refetchInterval: (query) => isTemporaryApiError(query.state.error) ? RECONNECT_INTERVAL_MS : false,
    refetchIntervalInBackground: true,
  });
  const claimMutation = useMutation({
    mutationFn: () => accessApi.claimBootstrapAdmin(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.health });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.stats });
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.currentBoardAccess });
    },
  });

  const activeQueries = [
    healthQuery,
    ...(isAuthenticatedMode ? [sessionQuery] : []),
    ...(isAuthenticatedMode && !isBootstrapPending && sessionQuery.data ? [boardAccessQuery] : []),
  ];
  const isServerStarting = healthQuery.data?.status === "starting";
  const isReconnecting = isServerStarting || activeQueries.some((query) => isTemporaryApiError(query.error));
  // A background outage must not unmount editors and discard drafts. Cached
  // access is only retained for transport failures; 401/403 still fail closed.
  const blockingError = activeQueries.find((query) => query.error
    && !(query.data !== undefined && isTemporaryApiError(query.error)))?.error;
  const isLoading =
    healthQuery.isLoading ||
    (isAuthenticatedMode && sessionQuery.isLoading) ||
    (isAuthenticatedMode && !isBootstrapPending && !!sessionQuery.data && boardAccessQuery.isLoading);
  // Self-serve instances let a signed-in user with no company through, so the
  // index redirect can take them to /start to name their first company.
  const selfServeCompanies = healthQuery.data?.features?.selfServeCompanies === true;
  const hasBoardAccess = allowMembershipRequest || !isAuthenticatedMode || selfServeCompanies
    || !!boardAccessQuery.data?.isInstanceAdmin || (boardAccessQuery.data?.companyIds.length ?? 0) > 0;
  const canAccessBoard = !isLoading && !blockingError && !isBootstrapPending
    && (!isAuthenticatedMode || !!sessionQuery.data) && hasBoardAccess;
  useEffect(() => {
    if (!canAccessBoard) setHasOpenedBoard(false);
    else if (healthQuery.data?.status === "ok") setHasOpenedBoard(true);
  }, [canAccessBoard, healthQuery.data?.status]);
  const wasReconnecting = useRef(false);
  useEffect(() => {
    if (isReconnecting) {
      wasReconnecting.current = true;
    } else if (wasReconnecting.current && !isLoading && !blockingError) {
      wasReconnecting.current = false;
      // Other reads (including the company list) may have failed during boot.
      // Refresh those too so recovery does not strand the user on a second error.
      void queryClient.invalidateQueries({ predicate: (query) => isTemporaryApiError(query.state.error) });
    }
  }, [isReconnecting, isLoading, blockingError, queryClient]);

  if (blockingError || (isServerStarting && !hasOpenedBoard)) {
    return (
      <CloudAccessError
        temporary={blockingError ? isTemporaryApiError(blockingError) : true}
        retrying={activeQueries.some((query) => query.isFetching)}
        onRetry={() => {
          for (const query of activeQueries) {
            if (query.error || (query === healthQuery && isServerStarting)) {
              void query.refetch({ cancelRefetch: false });
            }
          }
        }}
      />
    );
  }

  if (isLoading) {
    return <PaperclipLoading />;
  }

  if (isAuthenticatedMode && healthQuery.data?.cloud && !sessionQuery.data) {
    return <CloudSignIn cloud={healthQuery.data.cloud} returnTo={`${location.pathname}${location.search}${location.hash}`} />;
  }

  if (isBootstrapPending) {
    const health = healthQuery.data;
    if (!health) {
      return <PaperclipLoading />;
    }
    const claimError = claimMutation.error instanceof ApiError
      ? { status: claimMutation.error.status, message: claimMutation.error.message }
      : claimMutation.error instanceof Error
        ? { message: claimMutation.error.message }
        : null;
    return (
      <BootstrapPendingPage
        claimAvailable={health.deploymentExposure === "private"}
        hasActiveInvite={health.bootstrapInviteActive}
        session={sessionQuery.data}
        claimState={claimMutation.isSuccess ? "success" : claimMutation.isPending ? "claiming" : "idle"}
        claimError={claimError}
        onClaim={() => claimMutation.mutate()}
      />
    );
  }

  if (isAuthenticatedMode && !sessionQuery.data) {
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/auth?next=${next}`} replace />;
  }

  // Private invitation pages may let signed-in nonmembers request access.
  // Their token APIs still enforce membership before granting any authority.
  if (!hasBoardAccess) {
    return <NoBoardAccessPage />;
  }

  return (
    <>
      {isReconnecting && (
        <div role="status" className="bg-muted px-4 py-2 text-center text-sm text-muted-foreground">
          Connection interrupted. Reconnecting automatically…
        </div>
      )}
      <Outlet />
    </>
  );
}
