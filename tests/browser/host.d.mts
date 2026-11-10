import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { Readable } from "node:stream";

export type OwnedProcess = ChildProcess & {
  stdout: Readable;
  stderr: Readable;
};
export type OwnedSpawnOptions = Omit<SpawnOptions, "stdio"> & {
  stdio?: ["ignore" | "pipe", "pipe", "pipe"];
};
export interface ProcessRss {
  pid: number;
  parentPid: number | null;
  rssKiB: number;
  exited?: boolean;
  creationTime?: string;
  verifiedWinerror?: number;
}
export function executable(name: string, env?: NodeJS.ProcessEnv): string;
export function pythonExecutable(env?: NodeJS.ProcessEnv): string;
export function sourcePythonPath(...extra: string[]): string;
export function installedServerEnv(
  python: string,
  root: string,
  inherited?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv & {
  PYTHON: string;
  PYTHONNOUSERSITE: string;
  OPENDIRECTOR_ROOT: string;
  PATH: string;
};
export function spawnOwned(
  command: string,
  args: readonly string[],
  options?: OwnedSpawnOptions,
): OwnedProcess;
export function stopOwned(child?: ChildProcess | null): Promise<void>;
export const rssDefinition: string;
export function sampleProcessRss(ids: readonly number[]): ProcessRss[];
