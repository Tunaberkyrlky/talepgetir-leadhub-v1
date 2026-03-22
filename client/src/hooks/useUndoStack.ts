import { useCallback, useRef } from 'react';

interface UndoEntry {
    description: string;
    undo: () => void;
}

const MAX_STACK = 20;

/** Simple undo stack — push actions and pop with Ctrl+Z */
export function useUndoStack() {
    const stackRef = useRef<UndoEntry[]>([]);

    const push = useCallback((entry: UndoEntry) => {
        stackRef.current = [...stackRef.current.slice(-(MAX_STACK - 1)), entry];
    }, []);

    const pop = useCallback((): UndoEntry | null => {
        const stack = stackRef.current;
        if (stack.length === 0) return null;
        const entry = stack[stack.length - 1];
        stackRef.current = stack.slice(0, -1);
        return entry;
    }, []);

    const canUndo = useCallback(() => stackRef.current.length > 0, []);

    return { push, pop, canUndo };
}
