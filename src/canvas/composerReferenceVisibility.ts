/** Visibility of the generation-panel reference manager.

Service text-to-speech models still accept canvas connections, but those
references are context-only. The panel must show and allow removal of them
instead of hiding the whole manager because the mode is reading aloud.
*/
export type ComposerReferenceVisibilityInput = {
  firstLast: boolean;
  reading: boolean;
  music: boolean;
  musicReferences: boolean;
  incomingCount: number;
  mode: "image" | "video" | "audio";
};

export function composerReferenceVisibility(
  input: ComposerReferenceVisibilityInput,
) {
  const canManage = !input.firstLast && (!input.music || input.musicReferences);
  return {
    showStrip:
      canManage && (input.mode === "video" || input.incomingCount > 0),
    showEmptyAdd: canManage && input.incomingCount === 0,
    showMention: !input.reading && !input.music,
    showReadingContextNote: input.reading && input.incomingCount > 0,
  };
}
