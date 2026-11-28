# Case03 segment plan

> **Historical baseline:** This plan reproduces an archived ComfyUI baseline verbatim (including tail-frame padding and >6 s windows). Do not copy these legacy exceptions for new footage; follow [video-segment.md](../video-segment.md) for new plans.

The reviewed ComfyUI render used guide-capable FastH3 Omni at 24 FPS and 960 × 544, with Character Swap v1.5 at scale 1.0, eight steps and seed 0. Check the deployment's effective settings before comparing outputs. See the [run instructions](case03.md).

## Source windows and identity mapping

The following intervals use prepared-clip coordinates. Each `<Video 1>` already includes its context frames.

| Segment | Prepared source window | Playback sent to H3 | Ordered pictures | Role in the edit |
| --- | --- | --- | --- | --- |
| A | Source A `[0, 124)` | Reverse | 1 | Continues from the B anchor into the earlier center-performer section. |
| B | Source B `[0, 124)` | Reverse | 1, 2, 3, 4, 5 | Establishes all five replacement identities before either branch runs. |
| C | Source C `[0, 158)` | Forward | 1, 2, 3, 4, 5 | Carries the same five identities into the forward branch. |
| D | Source D `[0, 158)` | Forward | 1 | Continues the center-performer edit from C. |
| E | Source E `[0, 226)` | Forward | 1 | Continues from D and completes the center-performer edit. |

The original 27-second master has 675 decoded frames at 25 FPS. Normalize it to 648 frames at 24 FPS CFR, then verify the cut points. Reverse A and B before padding. Use the last frame in playback order for padding.

| Prepared clip | Normalized source window | Playback | Held frames at the end |
| --- | --- | --- | ---: |
| A | `[0, 84)` | Reverse | 40 |
| B | `[62, 180)` | Reverse | 6 |
| C | `[158, 308)` | Forward | 8 |
| D | `[286, 444)` | Forward | 0 |
| E | `[422, 648)` | Forward | 0 |

See the [saved prompts](case03_prompts.json) for picture assignments. In B, the central performer keeps Picture 1 as the other performers leave.

Match these SHA-256 digests before reusing the saved prompts.

| Input | SHA-256 |
| --- | --- |
| Complete source `KUN- what a day - 01m19s-01m46s 1366x768-letterbox.mp4` | `81e296568983ae880eb72342f2399220deeca3d7466a708076bd58800b1ed645` |
| Picture 1 `0_jensen_huang.jpeg` | `3bd41441bd3b537d1cc0eefcea28c82703ee5642f0b5916c7244144fea8d582a` |
| Picture 2 `02_sun_wukong.png` | `02408210003fede5c44e2ce096083c85ff6041211cb6b63d692ef600460f4e76` |
| Picture 3 `03_zhu_bajie.png` | `cbee9d3f57d508ae995cb6a4cc05e73b3d9c207f64650f34c40ea3f1203b7246` |
| Picture 4 `04_sha_seng.png` | `5b3089190d413a1258e46c57e7283577d3e59f606deff3310feace9797c3f73d` |
| Picture 5 `05_bai_long_ma (1).png` | `45d1906b367372ef00d6306db6acba3ed4459df4b8c6e0f97441b350e2c674fc` |

### Why B generates in reverse

The chronological B window starts with only the central performer and ends with all five assigned performers. Reverse that window before padding its input to 124 frames. H3 starts with all five assignments and follows the performers as they leave.

## Generation and assembly

The published group starts from B. It then uses the adopted raw result from this same execution for each continuation. The guide pairs below are zero-based donor indices in target slot order 0 and 21. Requested lengths include context and overlap and follow `17k + 5`.

Reverse the specified prefix before applying the half-open keep range. Assemble in order A, B, C, D, E.

| Segment | Guide source and raw indices | Requested frames | Reverse prefix | Keep for assembly | Final timeline range |
| --- | --- | ---: | ---: | --- | --- |
| A | B · 96, 117 | 124 | 84 | `[0, 80)` | `[0, 80)` |
| B | Starting anchor · No guide | 124 | 118 | `[18, 118)` | `[80, 180)` |
| C | B · 21, 0 | 158 | — | `[22, 150)` | `[180, 308)` |
| D | C · 128, 149 | 158 | — | `[22, 158)` | `[308, 444)` |
| E | D · 136, 157 | 226 | — | `[22, 226)` | `[444, 648)` |

The [structured frame plan](case03-frame-plan.json) partitions [0, 648) into five generated intervals. It has no source-only intervals. The archive includes a demo soundtrack. Bind the delivery soundtrack for the same interval before publishing.

### Check the unselected foreground crossing

A 768P OpenDirector render kept D's center performer and guide poses. It changed a foreground passer's outfit near source `[363, 379)`. A retake restored her outfit and copied it to a second background track. These frames fall within D's keep range and can affect E's guides.

For a controlled retake, copy the published group to a draft and change only D’s prompt. Try "The existing foreground passer keeps her own clothing and visibility from <Video 1>. Every other visible person keeps their own source appearance and track." Review D input `[77, 93)`, the background dancers and E's donor frames. Use the saved ComfyUI prompts as the baseline.
