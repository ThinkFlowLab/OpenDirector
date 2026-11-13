# Omni video declarations

These unmodified JSON responses were exported from the actual application at
[vllm-project/vllm-omni commit e71da6217950c9617dd06ce55146b9b2d309c06f](https://github.com/vllm-project/vllm-omni/commit/e71da6217950c9617dd06ce55146b9b2d309c06f)
(PR #10102). Application assembly used
substituted model engines; no inference was performed. They cover Wan I2V,
Wan VACE, SeedVR2 and the H3 single-stage `t2va` deployment, including input-role
declarations introduced in `b934b642`. The later `12d834c2` revision clarifies
documentation and does not change these declarations.

Tests freeze both clocks at the response's original `observed_at` so stale
observations cannot conceal a role decision. `image` and `first_frame` count
the same image; they are not two uploaded files. The public model ID is
`public-primary`; tests match it exactly.
