"""Time windows for reference videos longer than a model's reference budget.

A model that reads reference videos accepts only a short total length. Profiles
listed here take the end of an over-long clip instead of refusing it: the last
seconds are what an extension continues from, and they are a deterministic
choice that needs no extra setting. Admission and execution both derive the
windows from the same asset durations, so an accepted job always transmits the
range its snapshot implies.
"""

from opendirector.domain.rule_facts import REFERENCE_MEDIA_SECONDS

# Self-hosted vLLM-Omni Ref2VA (FastH3-Omni request shape, also Pika H3 adapters).
WINDOWED_PROFILES = frozenset({'fasth3-omni'})


def windows_reference_videos(profile: str) -> bool:
    return profile in WINDOWED_PROFILES


def reference_video_windows(durations_ms, limit_ms: int = REFERENCE_MEDIA_SECONDS * 1000):
    """Per-video `(start_ms, end_ms)` to transmit, or `None` where the whole clip is sent.

    Clips that fit the budget together are untouched. Otherwise the budget is
    shared by water-filling: short clips stay whole and the longest ones are cut
    to one common length, each keeping its final part.
    """
    durations = [int(value) for value in durations_ms]
    if any(value <= 0 for value in durations):
        raise ValueError('reference video durations must be positive')
    if sum(durations) <= limit_ms:
        return [None] * len(durations)
    remaining, left, cap = limit_ms, len(durations), 0
    for value in sorted(durations):
        if value * left <= remaining:
            remaining -= value
            left -= 1
        else:
            cap = remaining // left
            break
    return [(value - cap, value) if value > cap else None for value in durations]
