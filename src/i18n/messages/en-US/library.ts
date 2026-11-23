export const library = {
  "library.title": "Asset library",
  "library.sections": "Asset library sections",
  "library.tab.assets": "Assets",
  "library.tab.subjects": "Subjects",
  "library.tab.canvases": "Canvases",
  "library.tab.trash": "Trash",
  "library.search.placeholder": "Search",
  "library.search.label": "Search asset library",
  "library.close": "Close asset library",
  "library.action.close": "Close",
  "library.action.insert": "Import to canvas",
  "library.insertHint": "Create independent canvas nodes",
  "library.all": "All",
  "library.moveToTrash": "Move to trash",
  "library.busy": "Working, please wait.",
  "library.processing": "Working…",
  "library.loading": "Loading media.",
  "library.reading": "Loading media…",
  "library.issue.selectNode": "Select at least one node.",
  "library.issue.selectItem": "Select an item.",
  "library.issue.selectSource": "Select a source first.",
  "library.issue.subjectUnavailable": "The selected subject is unavailable.",
  "library.importUnavailable": "This source cannot be imported.",
  "library.selected": {
    one: "{count} item selected",
    other: "{count} items selected",
  },

  "library.category.image": "Images",
  "library.category.video": "Videos",
  "library.category.audio": "Audio",
  "library.category.file": "Documents",
  "library.category.text": "Text",
  "library.category.subject": "Subjects",
  "library.category.timeline": "Timelines",

  "library.assets.upload": "Upload assets",
  "library.assets.uploaded": {
    one: "Added {count} asset",
    other: "Added {count} assets",
  },
  "library.assets.trashed": {
    one: "Moved {count} asset to trash",
    other: "Moved {count} assets to trash",
  },
  "library.assets.loading": "Loading assets…",
  "library.assets.empty":
    'No assets yet. Upload from this computer, or add media from the "Canvases" tab.',

  "library.canvases.current": "Current canvas",
  "library.canvases.back": "‹ Back",
  "library.canvases.addToAssets": "Add to assets",
  "library.canvases.copied": "Added an independent copy to the asset library.",
  "library.canvases.noteCurrent": {
    one: "Current canvas · {count} node with content · read-only",
    other: "Current canvas · {count} nodes with content · read-only",
  },
  "library.canvases.note": {
    one: "{name} · {count} node with content · read-only",
    other: "{name} · {count} nodes with content · read-only",
  },
  "library.canvases.empty": "This canvas has no media of this type.",

  "library.subjects.add": "Add selected subject",
  "library.subjects.addHint":
    "Save the complete subject selected on the canvas to the subject library.",
  "library.subjects.trashed": {
    one: "Moved {count} subject to trash",
    other: "Moved {count} subjects to trash",
  },
  "library.subjects.loading": "Loading subjects…",
  "library.subjects.empty":
    'No subjects yet. Select a subject node with content on the canvas, then click "Add selected subject".',
  "library.subjects.unavailable": "This subject is unavailable.",

  "library.trash.restore": "Restore",
  "library.trash.purge": "Delete permanently",
  "library.trash.empty": "Empty trash",
  "library.trash.confirmLabel": "Confirm emptying trash",
  "library.trash.confirmBody":
    "These assets cannot be recovered after emptying. Assets on canvases are unaffected.",
  "library.trash.cancel": "Cancel",
  "library.trash.confirm": "Confirm empty",
  "library.trash.restored": {
    one: "Restored {count} asset",
    other: "Restored {count} assets",
  },
  "library.trash.purged": {
    one: "Permanently deleted {count} asset",
    other: "Permanently deleted {count} assets",
  },
  "library.trash.emptied": {
    one: "Emptied trash and freed {count} file",
    other: "Emptied trash and freed {count} files",
  },
  "library.trash.loading": "Loading trash…",
  "library.trash.emptyState": "Trash is empty.",

  "library.card.select": "Select: {title}",
  "library.card.starred": "Starred",

  "library.import.title": "Import subject",
  "library.import.sources": "Subject sources",
  "library.import.search": "Search subject sources",
  "library.import.close": "Close subject import",
  "library.import.hint.voice": "Choose an audio clip of 15 seconds or less",
  "library.import.hint.auxiliary": "Choose an additional image",
  "library.import.hint.main":
    "Choose an image, a video of 15 seconds or less, or a complete subject",
  "library.import.oneOnly": "one item per import",
  "library.import.empty": "No sources available.",
  "library.import.importing": "Importing…",
  "library.import.submitHint": "Import into the current subject",
  "library.import.submit": "Confirm",

  "library.source.assets": "Asset library",

  "library.media.readFailed": "Failed to read the asset.",
  "library.media.inlineReadFailed": "Cannot read the canvas asset content.",

  "library.subject.selectOne": "Select exactly one subject node on the canvas.",
  "library.subject.unlock": "Unlock the subject node or its group first.",
  "library.subject.none": "Select a subject first.",
  "library.subject.blank": "An empty subject cannot be imported.",
  "library.subject.singleLibrary":
    "Only one library subject can be selected for import.",
  "library.subject.incompatible":
    "The imported subject is incompatible with an existing downstream node type. Adjust the connections first.",
  "library.subject.mainRequired":
    "Add the subject's main image before adding additional images or audio.",
  "library.subject.singleMedia": "Choose a single media item.",
  "library.subject.slotMismatch":
    "This asset does not fit the current subject slot.",
  "library.subject.durationLimit":
    "Subject videos and audio must be 15 seconds or less.",
} satisfies Record<string, string | { one: string; other: string }>;
