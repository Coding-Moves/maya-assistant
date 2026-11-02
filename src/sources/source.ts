/** Sources emit normalized data into the app while owning their input lifecycle. */
export interface Source<T> {
  start(emit: (item: T) => void): Promise<void>;
  stop(): Promise<void>;
}
