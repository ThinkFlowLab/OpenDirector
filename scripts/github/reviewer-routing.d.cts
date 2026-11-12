export interface ReviewerInput {
  labels: string[];
  author: string;
  requested?: string[];
  reviewed?: string[];
}
export interface RoutingConfig {
  reviewers: Record<string, string[]>;
  fallback: string[];
}
export function selectReviewers(input: ReviewerInput, routing?: RoutingConfig): string[];
export function run(input: unknown): Promise<void>;
