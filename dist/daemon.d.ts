export declare class SerialQueue {
    private readonly pending;
    private readonly idleWaiters;
    private running;
    run<T>(operation: () => Promise<T> | T): Promise<T>;
    private executeNext;
    private settleIdle;
    private pump;
    /**
     * A long background sync calls this at restartable boundaries. Requests
     * already waiting in the same FIFO are completed before the background
     * continuation resumes, so a multi-gigabyte initial import cannot starve a
     * receipt behind an entire project scan.
     */
    cooperate(): Promise<void>;
    drain(): Promise<void>;
}
export declare function runDaemon(intervalMs?: number): Promise<void>;
