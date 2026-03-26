import { createContext, useContext, useState, useRef, useCallback, useEffect, type ReactNode } from 'react';
import api from '../lib/api';
import type { ImportResult } from '../lib/types';

const STORAGE_KEY = 'leadhub_import_active';

interface StoredSession {
    jobId: string;
    totalRows: number;
    fileName: string;
    startedAt: number; // timestamp ms
}

interface ImportProgressState {
    isImporting: boolean;
    isDone: boolean;
    isCancelling: boolean;
    fileName: string;
    totalRows: number;
    progressCount: number;
    startedAt: number | null;
    result: ImportResult | null;
}

interface ImportProgressContextValue extends ImportProgressState {
    currentJobId: string | null;
    startImport: (jobId: string, totalRows: number, fileName: string) => void;
    finishImport: (result: ImportResult) => void;
    cancelImport: () => void;      // called on API error (cleanup only)
    stopImport: () => Promise<void>; // called by user — sends cancel to server
    dismiss: () => void;
}

const ImportProgressContext = createContext<ImportProgressContextValue | null>(null);

export function ImportProgressProvider({ children }: { children: ReactNode }) {
    const [state, setState] = useState<ImportProgressState>({
        isImporting: false,
        isDone: false,
        isCancelling: false,
        fileName: '',
        totalRows: 0,
        progressCount: 0,
        startedAt: null,
        result: null,
    });

    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const currentJobIdRef = useRef<string | null>(null);

    const stopPoll = useCallback(() => {
        if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
        }
    }, []);

    const clearStorage = useCallback(() => {
        sessionStorage.removeItem(STORAGE_KEY);
    }, []);

    const startPolling = useCallback((jobId: string) => {
        stopPoll();
        pollRef.current = setInterval(async () => {
            try {
                const res = await api.get(`/import/jobs/${jobId}`);
                const job = res.data?.data;
                if (!job) return;

                setState((prev) => ({ ...prev, progressCount: job.progress_count ?? 0 }));

                if (job.status !== 'processing') {
                    stopPoll();
                }
            } catch {
                // ignore polling errors
            }
        }, 2500);
    }, [stopPoll]);

    const startImport = useCallback((jobId: string, totalRows: number, fileName: string) => {
        stopPoll();
        if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);

        const startedAt = Date.now();
        currentJobIdRef.current = jobId;

        // Persist to sessionStorage so bar survives page refresh
        const session: StoredSession = { jobId, totalRows, fileName, startedAt };
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));

        setState({
            isImporting: true,
            isDone: false,
            isCancelling: false,
            fileName,
            totalRows,
            progressCount: 0,
            startedAt,
            result: null,
        });

        startPolling(jobId);
    }, [stopPoll, startPolling]);

    const finishImport = useCallback((result: ImportResult) => {
        stopPoll();
        clearStorage();
        currentJobIdRef.current = null;

        setState((prev) => ({
            ...prev,
            isImporting: false,
            isCancelling: false,
            isDone: !result.cancelled,
            progressCount: result.totalRows,
            result: result.cancelled ? null : result,
        }));

        if (!result.cancelled) {
            dismissTimerRef.current = setTimeout(() => {
                setState((prev) => ({ ...prev, isDone: false }));
            }, 8000);
        }
    }, [stopPoll, clearStorage]);

    // Called on API error (no server cancel needed, just cleanup)
    const cancelImport = useCallback(() => {
        stopPoll();
        clearStorage();
        currentJobIdRef.current = null;
        setState((prev) => ({ ...prev, isImporting: false, isCancelling: false }));
    }, [stopPoll, clearStorage]);

    // Called by user clicking "Durdur" — sends cancel signal to server
    const stopImport = useCallback(async () => {
        const jobId = currentJobIdRef.current;
        if (!jobId) return;

        setState((prev) => ({ ...prev, isCancelling: true }));

        try {
            await api.post(`/import/cancel/${jobId}`);
        } catch {
            // Even if cancel request fails, cleanup client state
            cancelImport();
        }
        // Import runs synchronously — cancel flag is checked at DB checkpoints.
        // Bar will hide when the execute API returns and finishImport is called with cancelled=true.
    }, [cancelImport]);

    const dismiss = useCallback(() => {
        if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
        clearStorage();
        setState((prev) => ({ ...prev, isImporting: false, isDone: false }));
    }, [clearStorage]);

    // ── On mount: restore from sessionStorage if import was in progress ──
    useEffect(() => {
        const raw = sessionStorage.getItem(STORAGE_KEY);
        if (!raw) return;

        let session: StoredSession;
        try {
            session = JSON.parse(raw);
        } catch {
            sessionStorage.removeItem(STORAGE_KEY);
            return;
        }

        // Check job status from API
        api.get(`/import/jobs/${session.jobId}`)
            .then((res) => {
                const job = res.data?.data;
                if (!job || job.status !== 'processing') {
                    sessionStorage.removeItem(STORAGE_KEY);
                    return;
                }

                // Job still running — restore bar
                currentJobIdRef.current = session.jobId;
                setState({
                    isImporting: true,
                    isDone: false,
                    isCancelling: false,
                    fileName: session.fileName,
                    totalRows: session.totalRows,
                    progressCount: job.progress_count ?? 0,
                    startedAt: session.startedAt,
                    result: null,
                });

                startPolling(session.jobId);
            })
            .catch(() => {
                sessionStorage.removeItem(STORAGE_KEY);
            });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <ImportProgressContext.Provider
            value={{
                ...state,
                currentJobId: currentJobIdRef.current,
                startImport,
                finishImport,
                cancelImport,
                stopImport,
                dismiss,
            }}
        >
            {children}
        </ImportProgressContext.Provider>
    );
}

export function useImportProgress() {
    const ctx = useContext(ImportProgressContext);
    if (!ctx) throw new Error('useImportProgress must be used within ImportProgressProvider');
    return ctx;
}
