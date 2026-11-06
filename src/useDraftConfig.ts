import { useCallback, useMemo, useRef, useState } from "react";

import type { Config } from "./App.types";
import { configsHaveSameDraftValues, reconcileConfigDraft } from "./configDraft";

function onlyLocalRouterToggleChanged(current: Config, persisted: Config) {
  if (current.localRouterEnabled === persisted.localRouterEnabled) return false;
  const currentKeys = Object.keys(current) as Array<keyof Config>;
  if (currentKeys.length === Object.keys(persisted).length
    && currentKeys.every((key) => (
      key === "localRouterEnabled" || key === "settingsRevision" || Object.is(current[key], persisted[key])
    ))) {
    return true;
  }
  return configsHaveSameDraftValues({
    ...current,
    localRouterEnabled: persisted.localRouterEnabled,
  }, persisted);
}

export function useDraftConfig() {
  const [config, setConfig] = useState<Config | null>(null);
  const [dirty, setDirty] = useState(false);
  const persistedConfigRef = useRef<Config | null>(null);
  const draftConfigRef = useRef(config);
  draftConfigRef.current = config;

  const setPersistedConfig = useCallback((next: Config) => {
    if (persistedConfigRef.current && next.settingsRevision < persistedConfigRef.current.settingsRevision) return;
    persistedConfigRef.current = next;
    draftConfigRef.current = next;
    setConfig(next);
    setDirty(false);
  }, []);

  const pendingNativeRouterToggle = useMemo(() => Boolean(
    config &&
      persistedConfigRef.current &&
      !config.localRouterEnabled &&
      onlyLocalRouterToggleChanged(config, persistedConfigRef.current),
  ), [config]);

  function editConfig(next: Config) {
    draftConfigRef.current = next;
    setConfig(next);
    setDirty(!configsHaveSameDraftValues(next, persistedConfigRef.current));
  }

  function isOnlyNativeRouterToggle(current: Config) {
    const persisted = persistedConfigRef.current;
    return Boolean(persisted && onlyLocalRouterToggleChanged(current, persisted));
  }

  function adoptRouteConfig(incoming: Config) {
    const merged = reconcileConfigDraft(
      persistedConfigRef.current,
      draftConfigRef.current,
      incoming,
    );
    if (!merged) return null;
    persistedConfigRef.current = incoming;
    draftConfigRef.current = merged.config;
    setConfig(merged.config);
    return merged;
  }

  function adoptSavedConfig(incoming: Config, submitted: Config) {
    if (persistedConfigRef.current && incoming.settingsRevision < persistedConfigRef.current.settingsRevision) return null;
    const merged = reconcileConfigDraft(submitted, draftConfigRef.current, incoming);
    if (!merged) return null;
    persistedConfigRef.current = incoming;
    draftConfigRef.current = merged.config;
    setConfig(merged.config);
    setDirty(merged.dirty);
    return merged;
  }

  function discardDraft() {
    if (persistedConfigRef.current) {
      draftConfigRef.current = persistedConfigRef.current;
      setConfig(persistedConfigRef.current);
    }
    setDirty(false);
  }

  return {
    config,
    setConfig,
    dirty,
    setDirty,
    persistedConfigRef,
    setPersistedConfig,
    pendingNativeRouterToggle,
    canSyncCurrentProvider: !dirty || pendingNativeRouterToggle,
    editConfig,
    isOnlyNativeRouterToggle,
    adoptRouteConfig,
    adoptSavedConfig,
    discardDraft,
  };
}
