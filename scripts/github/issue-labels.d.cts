import type { Label } from './auto-labels.cjs';
export function allowed(name: string): boolean;
export function inputFor(issue: {title?: string; body?: string}): {title: string; body: string};
export function fallback(issue: {title?: string; body?: string}, catalog: Label[], existing: string[]): string[];
export function run(args: unknown): Promise<void>;
