/** A reload resumes its tab's owner, while every acquisition fences older pages.
 * Ordinary navigation gets a new owner even when a popup copied sessionStorage. */
const KEY = "opendirector.creation.session.v1";
const MAX_GENERATION = 2 ** 31 - 1;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createSessionIdentity(
  storage: Pick<Storage, "getItem" | "setItem"> | undefined,
  navigationType: string | undefined,
  newId = () => crypto.randomUUID(),
) {
  let id = newId();
  let issued = 0;
  let accepted = 0;
  try {
    const saved = JSON.parse(storage?.getItem(KEY) ?? "null");
    if (
      navigationType === "reload" &&
      UUID.test(saved?.id) &&
      Number.isInteger(saved.generation) &&
      saved.generation >= 0 &&
      saved.generation < MAX_GENERATION
    ) {
      id = saved.id;
      issued = saved.generation;
    }
  } catch {
    /* Unavailable or corrupt tab storage cannot establish ownership. */
  }
  function persist() {
    try {
      storage?.setItem(KEY, JSON.stringify({ id, generation: issued }));
    } catch {
      /* A fresh owner remains safe if storage is unavailable. */
    }
  }
  persist();
  return {
    id,
    issue() {
      if (issued >= MAX_GENERATION) throw new RangeError();
      issued++;
      // Persist before sending: a reload must also supersede an unacknowledged open.
      persist();
      return issued;
    },
    accept(generation: number) {
      accepted = Math.max(accepted, generation);
    },
    get accepted() {
      return accepted;
    },
    get issued() {
      return issued;
    },
  };
}

export function browserSessionIdentity() {
  let storage: Storage | undefined;
  try {
    storage = globalThis.sessionStorage;
  } catch {
    /* Restricted browser. */
  }
  const navigation = globalThis.performance?.getEntriesByType(
    "navigation",
  )[0] as PerformanceNavigationTiming | undefined;
  return createSessionIdentity(storage, navigation?.type);
}
