import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Visit, UploadStatus } from '../types/visit';
import { loadVisits, saveVisits, upsertVisit as persistUpsert, deleteVisit as persistDelete } from '../services/storage';
import { uploadVisit as apiUploadVisit } from '../services/api';

interface VisitStoreValue {
  visits: Visit[];
  ready: boolean;
  upsert: (v: Visit) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setStatus: (id: string, status: UploadStatus, error?: string, mondayItemId?: string) => Promise<void>;
  upload: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<VisitStoreValue | null>(null);

export const VisitStoreProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [visits, setVisits] = useState<Visit[]>([]);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    const v = await loadVisits();
    setVisits(v);
  }, []);

  useEffect(() => {
    (async () => {
      await refresh();
      setReady(true);
    })();
  }, [refresh]);

  const upsert = useCallback(async (v: Visit) => {
    const next = await persistUpsert(v);
    setVisits(next);
  }, []);

  const remove = useCallback(async (id: string) => {
    const next = await persistDelete(id);
    setVisits(next);
  }, []);

  const setStatus = useCallback(async (id: string, status: UploadStatus, error?: string, mondayItemId?: string) => {
    const all = await loadVisits();
    const idx = all.findIndex(v => v.id === id);
    if (idx < 0) return;
    all[idx] = {
      ...all[idx],
      status,
      lastError: error,
      mondayItemId: mondayItemId ?? all[idx].mondayItemId,
      updatedAt: new Date().toISOString(),
    };
    await saveVisits(all);
    setVisits(all);
  }, []);

  const upload = useCallback(async (id: string) => {
    const all = await loadVisits();
    const visit = all.find(v => v.id === id);
    if (!visit) throw new Error('Visit not found');

    // mark Uploading first so the UI reflects it before the await
    await setStatus(id, 'Uploading', undefined);

    try {
      const result = await apiUploadVisit(visit);
      await setStatus(id, 'Uploaded', undefined, result.itemId);
    } catch (err) {
      const msg = (err as Error).message || 'Upload failed';
      await setStatus(id, 'Failed', msg);
      throw err;
    }
  }, [setStatus]);

  const value = useMemo<VisitStoreValue>(() => ({
    visits, ready, upsert, remove, setStatus, upload, refresh,
  }), [visits, ready, upsert, remove, setStatus, upload, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export function useVisitStore(): VisitStoreValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useVisitStore must be used within VisitStoreProvider');
  return v;
}
