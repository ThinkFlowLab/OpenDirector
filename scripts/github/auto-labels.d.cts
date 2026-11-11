export interface Label { name: string; description?: string }
export interface File { filename: string; status?: string; patch?: string }
export function validate(content: string, catalog: Label[], existing: string[]): string[];
export function fallback(files: File[], catalog: Label[], existing: string[]): string[];
export function inputFor(pr: {title?: string; body?: string}, files: File[]): {files: File[]};
export function run(args: unknown): Promise<void>;
