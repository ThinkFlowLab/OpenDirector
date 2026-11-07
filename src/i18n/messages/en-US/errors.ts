export const errors = {
  "errors.tools.error.submissionUnknown": "The generation request's acceptance is unknown. Check whether the provider received it before submitting again; it will not be resubmitted automatically.",
  "errors.data.timelineShape": "The timeline size, frame rate, or tracks are invalid.",
  "errors.data.timelineAssets":
    "The timeline media library accepts only valid images, video, or audio.",
  "errors.data.timelineTrack":
    "A timeline track id, type, or clip list is invalid.",
  "errors.data.timelineClip":
    "A timeline clip, its source in/out points, speed, or volume is invalid.",
  "errors.data.timelineOutPoint":
    "A clip extends beyond the media's known duration.",
  "errors.data.timelineVisualKind":
    "Visual tracks accept only images or video; timing follows clip order.",
  "errors.data.timelineStill":
    "Still images use their display duration, not a source in-point or speed.",
  "errors.data.timelineAudio":
    "Audio clips need audio media and a non-negative timeline start.",
  "errors.data.timelineOverlap":
    "Clips on the same audio track cannot overlap. Adjust the start or use another track.",
  "errors.data.timelineVisualTrack":
    "The timeline must have exactly one visual track.",
  "errors.data.subject":
    "The subject description or supporting media is invalid; at most 3 supporting images are allowed.",
  "errors.data.subjectMain":
    "The subject's main media must be an image or video.",
  "errors.data.subjectVoice": "The subject's voice must be audio.",
  "errors.data.subjectAuxiliary":
    "The subject's supporting media must be images.",
  "errors.data.subjectOrder":
    "Add the subject's main media before supporting images or voice.",
  "errors.data.subjectVideoExtras":
    "A video subject cannot include extra images or separate audio.",
  "errors.data.subjectLibrary": "The subject library source record is invalid.",
  "errors.data.subjectDuplicateAsset":
    "A subject cannot reference the same asset id twice.",
  "errors.data.subjectDuplicateNode":
    "A subject cannot reference the same canvas node twice.",
  "errors.data.subjectVideoDuration":
    "A subject video cannot be longer than 15 seconds.",
  "errors.data.subjectVoiceDuration":
    "The subject voice must be 15 seconds or shorter.",
  "errors.data.stack": "The stack references or active choice are invalid.",
  "errors.data.tool": "The tool type or field list is invalid.",
  "errors.data.toolFields":
    "Tool fields allow at most 32 values, each up to 256 characters.",
  "errors.data.toolProvenance": "The tool source identifier is invalid.",
  "errors.data.paletteKind":
    "Palette metadata is only valid for the palette tool.",
  "errors.data.paletteName": "The palette name is invalid.",
  "errors.data.paletteSource":
    "The palette source must be a raw storage URI, not a web URL.",
  "errors.data.externalType":
    "External nodes must use the director-stage type.",
  "errors.data.externalVersion":
    "The external director stage version id must be a uint64 decimal string.",
  "errors.data.node":
    "The node title, prompt, media, or settings are invalid.",
  "errors.data.contentReference": "A structured content reference is invalid.",
  "errors.data.contentLimit":
    "Structured content exceeds the length or reference limit.",
  "errors.data.mentionRange": "A content reference range is invalid.",
  "errors.data.agent": "The Agent settings are invalid.",
  "errors.data.evidence": "The generation input record is invalid.",
  "errors.data.media": "The media pixel size or duration is invalid.",
  "errors.data.taskDraft": "The tool task draft is invalid.",
  "errors.data.localStage": "The local stage is invalid.",
  "errors.data.imageCrop": "The image editing document is invalid.",
  "errors.data.layers": "The editable layer content is invalid.",
  "errors.rules.firstLastReference":
    "First/last frame mode does not accept video or audio references.",
  "errors.rules.videoSubject":
    "A video subject can only be a reference for a video node.",
  "errors.rules.firstLastImage":
    "First/last frame mode requires image nodes for frame media.",
  "errors.rules.subjectEmpty": "The subject has no usable media yet.",
  "errors.rules.subjectReference":
    "The current model or mode does not accept media from a subject.",
  "errors.rules.nodeKind": "The local service does not accept this node type yet.",
  "errors.rules.textEmpty": "The text node is empty.",
  "errors.rules.textReference": "The current model does not accept text references.",
  "errors.rules.videoContinuation":
    "Video can only be the previous segment in Continuation mode.",
  "errors.rules.videoReference": "The current model does not accept video references.",
  "errors.rules.kindReference":
    "The current model does not accept {kind} references.",
  "errors.rules.mediaMissing": "The media has not been imported or was lost.",
  "errors.rules.modelMissing":
    "The selected model configuration was deleted or has not loaded. Choose it again in Settings.",
  "errors.rules.modelKind":
    "The model type does not match this node. Choose another model.",
  "errors.rules.depthModel":
    "A video depth model is only for depth motion capture. Choose a generation model.",
  "errors.rules.transcriptionModel":
    "A transcription model is only for reference-music generation. Choose a music generation model.",
  "errors.rules.segmentationModel":
    "A visual segmentation model is only for selections, segmentation, and matting. Choose a generation model.",
  "errors.rules.promptRequired": "Enter a generation prompt.",
  "errors.rules.layoutReferences": "MOSS layout JSON cannot be combined with text references. Put the requirements in the JSON or remove the text references.",
  "errors.rules.promptTooLong": "This model accepts up to {limit} prompt characters. Shorten the prompt and try again.",
  "errors.rules.musicStyle": "Describe the music style.",
  "errors.rules.speechText": "Enter the text to synthesize.",
  "errors.rules.productViews":
    "This service does not support the product three-view preset. Use free creation.",
  "errors.rules.imageSize":
    "The image adapter does not support the selected ratio or size. Choose again.",
  "errors.rules.musicModel":
    "The selected model is for music generation. Choose another model.",
  "errors.rules.musicDuration":
    "Music duration must be between {min} and {max} seconds.",
  "errors.rules.lyricsLimit": "Lyrics can be at most 5,000 characters.",
  "errors.rules.referenceMusic":
    "The selected music model does not support reference music. Use YuE2 or disconnect the reference.",
  "errors.rules.transcriptionRequired":
    "Reference music needs a transcription first. Add a transcription model in Model Connections (vLLM-Omni transcription endpoint).",
  "errors.rules.speechOnly": "The current speech service only supports text-to-speech.",
  "errors.rules.voiceId":
    "Enter a voice id supported by the service (letters, numbers, dots, underscores, or hyphens).",
  "errors.rules.voiceRequired": "Enter a valid Voice ID from the service's voice library before generating.",
  "errors.rules.referencesUnsupported": "This model does not support references. Disconnect the references before generating.",
  "errors.generationFailure.voiceNotFound": "The voice was not found or is unavailable to this account. Check the Voice ID in the MOSS voice library.",
  "errors.rules.audioDisable":
    "The video adapter does not support disabling generated audio.",
  "errors.rules.duration":
    "The model does not support the selected duration. Choose again.",
  "errors.rules.resolution":
    "The model or reference mode does not support the selected resolution. Choose again.",
  "errors.rules.videoMode": "The model does not support the selected video mode.",
  "errors.rules.lastFrame":
    "The current service only supports a first frame. Remove the last frame.",
  "errors.rules.lastFrameMissing":
    "The last-frame media is disconnected or missing. Choose it again.",
  "errors.rules.firstFrameMissing":
    "The first-frame media is disconnected or missing. Choose it again.",
  "errors.rules.continuationSource":
    "Continuation needs a video generated by the current H3 service as the previous segment.",
  "errors.rules.referenceLimit":
    "Too many {kind} references for this model (limit: {limit}).",
  "errors.rules.referenceFileSize":
    "A reference file exceeds the model's size limit.",
  "errors.rules.referenceBudget":
    "Total reference size exceeds the model's request budget.",
  "errors.rules.referenceCount": "Too many references for this model.",
  "errors.rules.kindImage": "image",
  "errors.rules.kindVideo": "video",
  "errors.rules.kindAudio": "audio",
  "errors.rules.kindText": "text",
  "errors.rules.kindSubject": "subject",
  "errors.storage.json": "The canvas JSON could not be parsed: {reason}",
  "errors.storage.document": "The canvas version, id, or title is invalid.",
  "errors.storage.arrays": "The canvas is missing its nodes or edges array.",
  "errors.storage.viewport":
    "Canvas zoom must be between {min} and {max}, and coordinates must be finite numbers.",
  "errors.storage.settings": "The canvas generation settings are invalid.",
  "errors.storage.hidden": "The hidden-source format is invalid.",
  "errors.storage.node":
    "A node id, type, position, size, or grouping field is invalid.",
  "errors.storage.duplicateNode": "Duplicate node id: {id}",
  "errors.storage.nodeDetail": "Node {id}: {reason}",
  "errors.storage.stackRoot": "A stack must stay at the canvas root.",
  "errors.storage.stackMembers":
    "Stack members must be independent referenceable root nodes that are not part of another stack.",
  "errors.storage.parentMissing":
    "The parent of node {id} does not exist or is not a group.",
  "errors.storage.parentCycle": "The group chain for node {id} contains a cycle.",
  "errors.storage.edge":
    "An edge has an invalid shape or references a missing node.",
  "errors.storage.duplicateEdge": "Duplicate edge id: {id}",
  "errors.storage.frameReference":
    "First and last frames must reference connected nodes.",
  "errors.storage.toolDraft": "The tool draft references a missing node.",
  "errors.storage.projectFrames":
    "Project settings reference a missing first or last frame.",
  "errors.storage.transientBlob":
    "Media \"{title}\" still uses a temporary blob URL. Convert it to a data URL before saving so it is not lost on refresh.",
  "errors.storage.serialize":
    "The canvas could not be serialized. Reduce project media or split the project: {reason}",
  "errors.storage.unknown": "Unknown error",
  "errors.backend.projectRequired": "Open a local project first.",
  "errors.backend.selectionAborted":
    "The project changed. Reopen the selection tool.",
  "errors.backend.openFailed":
    "Could not open the project: {error}. The previous project could not regain edit access: {restore}",
  "errors.backend.snapshotMismatch": "The project snapshot identity does not match.",
  "errors.backend.subscribeFailed": "Could not subscribe to changes.",
  "errors.backend.eventMismatch": "The project event identity does not match.",
  "errors.backend.uploadFailed":
    "Could not upload the media. Check its format and size.",
  "errors.backend.assetIdentity":
    "Media registration did not return a stable identity.",
  "errors.backend.taskMissing": "The task does not exist.",
  "errors.backend.taskBasisChanged":
    "The task inputs changed. Review the task again.",
  "errors.backend.noGenerationConfig":
    "This node has no generation configuration.",
  "errors.backend.resultMissing":
    "The result file is missing or changed. Check the local file.",
  "errors.backend.resultCurrent": "Currently selected generation result",
  "errors.backend.resultNode": "Result shown as a separate node",
  "errors.backend.resultHistory": "Historical generation result",
  "errors.backend.resultCandidate": "Result kept as a candidate",
  "errors.backend.mediaEmpty": "The media has no readable content.",
  "errors.backend.mediaReadFailed": "Could not read the media.",
  "errors.backend.unsupportedGeneration":
    "This node does not support generation settings.",
  "errors.backend.assemblyMissing":
    "The subject media or timeline clip for an assembly edge no longer exists.",
  "errors.backend.toolSourceMissing":
    "The tool source has not been saved or has changed. Reopen the editor.",
  "errors.backend.editorCommand": "This editor requires a dedicated command.",
  "errors.backend.openUnifiedProject": "Open the unified project first.",
  "errors.backend.materialReference":
    "A media node cannot accept a generation reference directly.",
  "errors.backend.fixedReferenceMissing":
    "The pinned reference version is missing or its content changed.",
  "errors.backend.savingResult": "The result is being saved. Try again shortly.",
  "errors.backend.editSourceUnsaved": "The edit source has not been saved.",
  "errors.backend.notDirectorStage": "This is not a publishable director stage.",
  "errors.backend.noRealMedia": "The edit source has no real media.",
  "errors.backend.priorResultSaved":
    "An earlier result was saved; this output has not been submitted. Review it and apply again.",
  "errors.backend.blankReference": "Blank text cannot be used as a reference.",
  "errors.backend.sourceChanged":
    "The selected source changed. Choose it again.",
  "errors.backend.projectNotOpen":
    "The project is not in the openable list. Check the project file and try again.",
  "errors.backend.untitled": "Untitled canvas",
  "errors.backend.untitledSuffix": "Untitled canvas ({suffix})",
  "errors.backend.generationTask": "Generation task",
  "errors.backend.importCanvas": "Imported canvas",
  "errors.backend.selectionFile": "edited-selection.png",
  "errors.backend.toolSelectionFile": "tool-selection.png",
  "errors.backend.paletteSourceTitle": "Palette source",
  "errors.backend.referenceFallback": "Reference",
  "errors.videoCapabilities.durationFormat":
    "Enter whole seconds or ranges, for example 4-10,15.",
  "errors.videoCapabilities.durationRange":
    "Durations must be 1–60 seconds, and a range cannot start after it ends.",
  "errors.videoCapabilities.outputCount": "Configure 1–20 output profiles.",
  "errors.videoCapabilities.resolutionName":
    "Invalid resolution name, for example 480P, 720P, 4K.",
  "errors.videoCapabilities.pixelPair":
    "Enter both pixel width and height, or leave both empty.",
  "errors.videoCapabilities.pixelRequired":
    "This adapter needs explicit pixel width and height (only H3 480P and 768P can be derived from the tier).",
  "errors.videoCapabilities.pixelBounds":
    "Landscape width and height must be integers from 64 to 8192, with width at least height, and must match the pixel alignment step.",
  "errors.videoCapabilities.duplicateResolution":
    "Resolutions cannot repeat.",
  "errors.videoCapabilities.defaultOutput":
    "The default resolution and duration must belong to a declared output profile.",
  "errors.tools.saveBeforeSubmit":
    "Save the tool settings before submitting the task.",
  "errors.tools.taskCancelled": "The task was cancelled.",
  "errors.tools.taskIncomplete": "The tool task did not complete.",
  "errors.tools.resultRetry":
    "Reading the result failed temporarily; retrying automatically.",
  "errors.tools.resultMissing":
    "The result file is missing; the task record is kept.",
  "errors.tools.resultReadFailed": "Could not read the result: {error}",
  "errors.tools.addedToCanvas": "Added to canvas",
  "errors.tools.sourceChanged":
    "The source changed. The result is kept in history and can be placed again.",
  "errors.tools.waitingForCanvas": "Waiting to add to canvas",
  "errors.tools.selectionAsset": "Selection",
  "errors.tools.annotationAsset": "Edit annotation",
  "errors.tools.phase.prepare": "Preparing media",
  "errors.tools.phase.stopping": "Stopping",
  "errors.tools.phase.outpaint": "Extending the frame",
  "errors.tools.phase.describeEdit": "Editing from the description",
  "errors.tools.phase.detail": "Enhancing details ({current}/{total})",
  "errors.tools.phase.upscaleEdge": "Upscaling to {edge}px",
  "errors.tools.phase.selection": "Applying the selection",
  "errors.tools.phase.cutout": "Detecting and cutting out the subject",
  "errors.tools.phase.boxObjects": "Detecting boxed objects ({current}/{total})",
  "errors.tools.phase.recognize": "Recognizing \"{label}\"",
  "errors.tools.phase.background": "Filling in the background",
  "errors.tools.phase.removeFill": "Removing and filling",
  "errors.tools.phase.newView": "Generating a new view",
  "errors.tools.phase.relight": "Relighting",
  "errors.tools.phase.generateTitle": "Generating {title} ({current}/{total})",
  "errors.tools.phase.productScene": "Blending the product and scene",
  "errors.tools.phase.poster": "Generating the motion poster",
  "errors.tools.phase.redraw": "Redrawing",
  "errors.tools.phase.redrawCount": "Redrawing ({current}/{total})",
  "errors.tools.phase.compose": "Compositing the result",
  "errors.tools.phase.organizeVideo": "Preparing the video",
  "errors.tools.phase.track": "Detecting and tracking \"{labels}\"",
  "errors.tools.phase.matteVideo": "Compositing the matte video",
  "errors.tools.phase.depth": "Estimating depth for every frame",
  "errors.tools.phase.separateAudio": "Separating the audio track",
  "errors.tools.phase.upscaleVideo": "Upscaling the video",
  "errors.tools.phase.interpolate": "Interpolating to {fps} fps",
  "errors.tools.phase.save": "Saving the result",
  "errors.tools.phase.generic": "Processing media…",
  "errors.tools.error.interrupted":
    "The service restarted and the task was interrupted. Submit it again.",
  "errors.tools.error.cancelled": "Cancelled.",
  "errors.tools.error.failed":
    "The tool failed. Check the media and parameters and try again.",
  "errors.tools.error.resultProcessing":
    "Processing the generated result failed. Check the service protocol; it will not be resubmitted automatically.",
  "errors.tools.error.modelChanged":
    "The accepted tool task's model configuration changed. Start a new attempt.",
  "errors.tools.error.cancelUnconfirmed":
    "The provider cancellation is unconfirmed.",
  "errors.tools.error.generic": "The tool task did not complete. Try again.",
  "errors.tools.error.localStopped": "Local processing stopped.",
  "errors.tools.error.serviceInterrupted":
    "The service was interrupted. Execution records are kept; the task will not be regenerated automatically.",
  "errors.tools.error.serviceInterruptedRemote":
    "The service was interrupted. Execution records are kept; check the provider state. The task will not be regenerated automatically.",
  "errors.tools.needCapabilities":
    "Connect a model with these capabilities: {capabilities}.",
  "errors.tools.needSelectionModel":
    "Connect an image segmentation model to detect selections automatically; you can still draw one manually.",
  "errors.tools.taskMessage.stopping":
    "Stopping; waiting for the current operation to finish safely.",
  "errors.tools.taskMessage.notApplicable":
    "No model call has been submitted.",
  "errors.tools.taskMessage.notRequired":
    "The model call has finished; existing results and records are kept.",
  "errors.tools.taskMessage.notRequested":
    "No cancellation request has been sent to the provider.",
  "errors.tools.taskMessage.requested":
    "The cancellation request was sent; waiting for the provider to confirm.",
  "errors.tools.taskMessage.confirmed":
    "The provider confirmed the cancellation.",
  "errors.tools.taskMessage.unsupported":
    "The provider does not support cancellation and may keep running.",
  "errors.tools.taskMessage.unknown":
    "The provider cancellation result is unknown. Check the original task; do not resubmit it directly.",
  "errors.tools.taskMessage.stopped":
    "Local processing stopped. {detail}",
  "errors.tools.taskMessage.cancelledHistory":
    "The history entry is marked cancelled without provider confirmation.",
  "errors.tools.taskMessage.interruptedUnknown":
    "Some model call results are unknown. Check the original task.",
  "errors.tools.taskMessage.interruptedRunning":
    "The provider task is still running.",
  "errors.tools.taskMessage.interruptedEnded":
    "The model calls finished; execution records and registered results are kept.",
  "errors.tools.taskMessage.interrupted":
    "Execution was interrupted. {detail}It will not be regenerated automatically.",
  "errors.backend.sourceMediaChanged":
    "The source media changed. Choose it again.",
  "errors.backend.editSaving": "The edit is being saved. Try again shortly.",
  "errors.backend.saveConflict":
    "The node was updated and this edit conflicts with the new version. Export the unsaved copy, then load the server version to review it.",
  "errors.backend.editChangedAfterSave":
    "The edit was saved, but its content changed afterwards. The draft is kept; reopen it to check the latest version.",
  "errors.backend.priorEditSaved":
    "The previous edit save was confirmed. This draft has not been submitted; review it and apply again.",
  "errors.backend.mediaFallback": "Media",
  "errors.backend.imageRead":
    "Could not read the source image. Import it again.",
  "errors.backend.readTimeout": "The read timed out. Try again.",
  "errors.backend.timelineSourceMissing": "The timeline source does not exist.",
  "errors.backend.priorToolUnconfirmed":
    "The previous tool submission is not confirmed yet. Query the original task first.",
  "errors.results.projectChanged":
    "The project changed, so the result was not written to the canvas.",
  "errors.results.sourceDeleted":
    "The source node was deleted, so the result was not written to the canvas.",
  "errors.results.sourceTypeChanged":
    "The source node type changed, so the result was not written to the canvas.",
  "errors.results.sourceMediaChanged":
    "The source media changed or is unavailable. Reopen the tool.",
  "errors.results.sourceLocked": "The source node is locked. Unlock it first.",
  "errors.results.sourceLockedHistory":
    "The source node is locked; the result is still kept in generation history.",
  "errors.results.kindMismatch":
    "The generation result does not match the node's media type.",
  "errors.results.mediaChangedHistory":
    "The node media changed; the result is still kept in generation history.",
  "errors.results.identityMismatch":
    "The tool result identity does not match.",
  "errors.results.noMedia": "The result contains no valid media.",
  "errors.results.draftMismatch":
    "The edit draft does not match the source node.",
  "errors.results.identityExists": "A result node with this identity exists.",
  "errors.results.invalidResult":
    "The tool result identity or media is invalid.",
  "errors.results.nodeModifiedHistory":
    "The result node was modified, locked, or removed; the result is kept in history.",
  "errors.results.nodeModified":
    "The result node was modified; the result is kept in history.",
  "errors.media.cancelled": "Media processing was cancelled.",
  "errors.media.readFailed": "Could not read the result file.",
  "errors.media.seekFailed": "Could not seek in the video.",
  "errors.media.seekTimeout": "Seeking in the video timed out.",
  "errors.media.noRecorder":
    "This browser cannot re-encode video locally; captureStream and MediaRecorder are required.",
  "errors.media.cropRange": "The video crop range is invalid.",
  "errors.media.noCaptureStream":
    "This browser does not support the Canvas captureStream needed for video cropping.",
  "errors.media.noEncoder":
    "This browser has no available WebM encoder.",
  "errors.media.noData": "Video encoding produced no data.",
  "errors.media.stopFailed": "Could not stop video encoding.",
  "errors.media.playbackInterrupted":
    "Video playback was interrupted; no crop was produced.",
  "errors.media.paused":
    "Playback paused during recording, so processing stopped.",
  "errors.media.drawFailed":
    "Drawing the video frame failed; no crop was produced.",
  "errors.media.timeout":
    "Video playback or recording timed out. Check the media and try again.",
  "errors.media.stalled":
    "Video playback stalled; nothing was produced. Please try again.",
  "errors.media.reencodeFailed": "Video re-encoding failed.",
  "errors.videoAction.options":
    "Choose an option supported by this operation.",
  "errors.videoAction.duration":
    "Wait until the video duration is known, then choose a valid range.",
  "errors.videoAction.prompt": "Describe the change you want.",
  "errors.videoAction.minDuration":
    "Video editing needs media that is 4–30 seconds long.",
  "errors.videoAction.depthDuration":
    "Depth motion capture needs media no longer than 30 seconds.",
  "errors.videoAction.audioDescription": "Describe the sound to separate.",
  "errors.videoAction.confirmSubtitles": "Confirm subtitle removal.",
  "errors.videoAction.frameNotReady":
    "The current video frame is not decoded yet. Wait and capture again.",
  "errors.videoAction.canvas":
    "The browser cannot create a frame-capture canvas.",
  "errors.videoAction.videoRead": "Could not read the video file.",
  "errors.videoAction.preciseDecode":
    "This browser cannot precisely decode the first and last frames of this video.",
  "errors.videoAction.frameDecode": "Video frame decoding failed.",
  "errors.videoAction.frameExport": "Video frame export failed.",
  "errors.videoAction.audioRead": "Could not read the video audio track.",
  "errors.videoAction.firstFrame": "first frame",
  "errors.videoAction.lastFrame": "last frame",
  "errors.videoAction.audioTrack": "audio track",
  "errors.videoAction.cropTitle": "Frame crop",
  "errors.videoAction.trimTitle": "Duration trim",
  "errors.text.noAgent":
    "Configure and select an Agent model in Settings first.",
  "errors.text.promptRequired": "Enter a generation request.",
  "errors.text.maxTokens": "Maximum output length must be 1–32768.",
  "errors.text.unsupportedKind":
    "The current Agent does not support the media type of {title}.",
  "errors.text.referenceUnavailable": "Reference media unavailable: {title}",
  "errors.text.referenceLimit":
    "The reference count exceeds the current Agent model limit.",
  "errors.text.projectChanged":
    "The project changed; the text result is kept in generation history.",
  "errors.text.sourceChanged":
    "The text source was deleted or changed; the result is kept in generation history.",
  "errors.text.locked":
    "The text node is locked; the result is kept in generation history.",
  "errors.text.bodyChanged":
    "The node body changed; the result is kept in generation history.",
  "errors.text.nodeMissing": "The text node no longer exists.",
  "errors.operations.pasteOffset": "The paste offset must be a finite number.",
  "errors.operations.stackCopy":
    "A copied stack must include the nodes it references.",
  "errors.operations.duplicateEdge": "Duplicate edge id.",
  "errors.operations.copyEdge":
    "Both ends of a copied edge must belong to the copied nodes.",
  "errors.operations.stackSelection":
    "Creating a stack requires selecting 2–50 nodes.",
  "errors.operations.stackMembers":
    "Stack members must be referenceable nodes that are unlocked, ungrouped, and not part of another stack.",
  "errors.operations.stackInvalid":
    "The stack reference is invalid, or a member already belongs to another stack.",
  "errors.operations.stackLocked":
    "Locked nodes cannot be added to a stack.",
  "errors.operations.stackUnlock":
    "Unlock the nodes you want to remove first.",
  "errors.mask.size":
    "The mask size does not match the source image. Try again.",
  "errors.mask.sizeShort":
    "The mask size does not match the source image.",
  "errors.mask.recognized":
    "{count, plural, one {Recognized # object. Adjust it with quick select, the brush, or the eraser.} other {Recognized # objects. Adjust them with quick select, the brush, or the eraser.}}",
  "errors.mask.none":
    "No objects recognized. Draw a box around the subject or describe it more specifically.",
  "errors.mask.failed":
    "Subject recognition failed. Try again or paint the mask manually.",
  "errors.mask.selectFirst":
    "Run auto recognition or draw a box around the subject first, then click an object to adjust the selection.",
  "errors.mask.noObject":
    "No recognized object here. Add one with a box or by painting.",
  "errors.mask.removed": "Removed this object.",
  "errors.mask.added": "Added this object.",
  "errors.nodeAction.extendNeedsVideo":
    "Extending a video requires an existing video node.",
  "errors.nodeAction.extendPrompt":
    "Extend 5 seconds from the end of the reference video, keeping the people, scene, and motion continuous.",
  "errors.nodeAction.extendTitle": "Extend",
  "errors.nodeAction.gridRange":
    "Grid split needs 1–7 rows and 1–7 columns, producing at least 2 images.",
  "errors.nodeAction.gridPixels":
    "The row and column counts cannot exceed the image pixel dimensions.",
  "errors.nodeAction.gridImage":
    "Grid split requires a readable image node.",
  "errors.nodeAction.gridCanvas":
    "The browser cannot create an image-split canvas.",
  "errors.nodeAction.gridEncode": "Encoding the image-split result failed.",
  "errors.nodeAction.gridTitle": "Grid split · row {row}, column {column}",
  "errors.export.range": "The time is outside the FCPXML export range.",
  "errors.export.missingMedia":
    "Media \"{title}\" has no file, so the full media bundle cannot be exported.",
  "errors.export.emptyTimeline": "Add clips to the timeline first.",
  "errors.export.fpsRange":
    "The project frame rate is outside the FCPXML rational range.",
  "errors.export.frameRange":
    "The timeline is outside the FCPXML frame-count range.",
  "errors.export.clipShort":
    "Clip \"{title}\" is shorter than one project frame and cannot be exported.",
  "errors.export.zipEntries":
    "The media count exceeds the ZIP32 limit.",
  "errors.export.zipName":
    "A media-bundle file name is invalid or duplicated.",
  "errors.export.zipSize":
    "The media bundle exceeds the 4 GiB ZIP32 limit. Split the timeline.",
  "errors.export.zipDirectory":
    "The media-bundle directory exceeds the ZIP32 limit.",
  "errors.export.missingFile": "\"{title}\" has no media file.",
  "errors.export.notLocal":
    "\"{title}\" is not local media. Import the media file first.",
  "errors.export.readFailed": "Could not read \"{title}\": {status}",
  "errors.export.emptyFile":
    "\"{title}\" is empty, so the media bundle was not exported.",
  "errors.export.readme":
    "OpenDirector FCPXML 1.10\nExtract the whole folder, then import project.fcpxml and keep the media relative paths.\nIncludes the original media, clip in/out points, order, speed, volume, mute, and multiple audio tracks; media is not transcoded.\nNLEs that support FCPXML can read it; the exact version and source codec support determine import compatibility. This does not claim direct import into Premiere or native CapCut projects.\nThe receiving application reads the real frame rate, channels, and sample rate; clip boundaries align to whole project frames, while source in-points and speed-change points use microsecond precision.\nFCPXML standard: https://developer.apple.com/documentation/professional-video-applications/creating-fcpxml-documents\n",
  "errors.zip.path": "Invalid path inside the archive: {path}",
  "errors.zip.exportSize":
    "The export exceeds the single-archive size limit. Split the project and try again.",
  "errors.zip.unsupportedExtract":
    "This browser cannot extract .canvas files.",
  "errors.zip.damaged": "The archive is damaged and cannot be extracted.",
  "errors.zip.notCanvas": "The file is not a valid .canvas archive.",
  "errors.zip.directoryRange":
    "The archive directory is outside the file bounds.",
  "errors.zip.directoryDamaged":
    "The archive directory is damaged and cannot be read.",
  "errors.zip.encrypted": "The archive content is encrypted: {name}",
  "errors.zip.zip64": "ZIP64 archives are not supported yet.",
  "errors.zip.entryDamaged":
    "An archive entry is damaged and cannot be read.",
  "errors.zip.entryRange": "An archive entry is outside the file bounds.",
  "errors.zip.unsupportedMethod":
    "The archive uses an unsupported compression method: {method}",
  "errors.zip.checksum": "Archive entry checksum failed: {name}",
  "errors.model.duplicateNode": "Duplicate node id: {id}",
  "errors.model.nodeSize":
    "Node width and height must be positive, and coordinates must be finite numbers.",
  "errors.model.move": "Move coordinates must be finite numbers.",
  "errors.model.duplicateEdge": "Duplicate edge id: {id}",
  "errors.model.edgeEnds":
    "Both ends of an edge must be nodes in the current canvas.",
  "errors.model.untitled": "Untitled canvas",
  "errors.archive.readMedia":
    "Could not read the canvas media, so no incomplete copy was exported.",
  "errors.archive.mediaFallback": "Media",
  "errors.archive.canvasFallback": "Canvas",
  "errors.archive.transientMedia":
    "The canvas media still uses a temporary URL, so no incomplete copy was exported.",
  "errors.archive.noManifest":
    "This is not an OpenDirector canvas archive: manifest.json is missing.",
  "errors.archive.manifestInvalid":
    "manifest.json in the canvas archive could not be parsed.",
  "errors.archive.notCanvas":
    "This is not an OpenDirector canvas archive; nothing was imported.",
  "errors.archive.versionInvalid":
    "The canvas archive format version is invalid.",
  "errors.archive.versionNewer":
    "This canvas was exported by a newer OpenDirector version (format v{version}) and cannot be read by this version.",
  "errors.archive.missingDocument":
    "The archive is missing its canvas file: {path}",
  "errors.archive.documentInvalid":
    "The canvas JSON could not be parsed; nothing was imported.",
  "errors.archive.transientReference":
    "The canvas references temporary media URLs; the archive is damaged and nothing was imported.",
  "errors.archive.missingMedia":
    "Media referenced by the canvas is missing: {entry}; nothing was imported.",
  "errors.upload.kindImage": "image",
  "errors.upload.kindVideo": "video",
  "errors.upload.kindAudio": "audio",
  "errors.upload.kindText": "text",
  "errors.upload.kindMismatch":
    "This node only accepts {kind} media, and the uploaded file type does not match.",
  "errors.upload.unsupported":
    "This operation does not support this media type.",
  "errors.upload.size": "The reference file exceeds the size limit ({kib} KiB).",
  "errors.pendingRef.unsupported":
    "This type cannot be used as a chat reference yet.",
  "errors.pendingRef.mediaMissing":
    "The media is missing. Restore the original file first.",
  "errors.pendingRef.noAsset":
    "There is no saved asset yet. Upload, save text, or wait for generation to finish.",
  "errors.pendingRef.blankNode": "Blank node",
  "errors.pendingRef.limit":
    "At most {count} reference items can be added at once; nothing was inserted.",
  "errors.pendingRef.textLimit":
    "The body is limited to {max} characters; nothing was inserted.",
  "errors.pendingRef.batchSuffix": "Nothing was inserted.",
  "errors.refs.cancelled": "Source selection was cancelled.",
  "errors.refs.cancelledWithSaved":
    "Source selection was cancelled. {count} registered items are kept in project media, and no references were inserted.",
  "errors.refs.uploadFailed": "Upload failed",
  "errors.refs.uploadFailedWithSaved":
    "{error} {count} items were registered and can be chosen from project media; no references were inserted.",
  "errors.refs.pickerAria": "Choose an existing reference source",
  "errors.refs.pickerTitle": "Choose an existing reference source",
  "errors.refs.pickerHint":
    "Several sources have identical file content. Choose the source to follow.",
  "errors.refs.existing": "Existing source",
  "errors.refs.projectAsset": "Project media",
  "errors.refs.cancel": "Cancel",
  "errors.preview.aria": "{name} preview",
  "errors.preview.unavailable": "This media cannot be previewed right now",
  "errors.preview.empty": "No previewable media",
  "errors.preview.loading": "Loading preview…",
  "errors.preview.emptyText": "(empty text)",
  "errors.preview.longText":
    "The text is long; open the node to read it.",
  "errors.preview.secondsUnit": "{value} s",
  "errors.connections.reference": "Reference edge",
  "errors.connections.delete": "Delete this edge",
  "errors.download.invalidUrl":
    "The embedded media URL is invalid and cannot be downloaded.",
  "errors.download.corrupt":
    "The embedded media data is damaged; the download file cannot be created.",
  "errors.download.fallbackName": "Media",
  "errors.stage.motionIdle": "Standing",
  "errors.stage.motionWalk": "Walking",
  "errors.stage.motionRun": "Running",
  "errors.stage.motionWave": "Waving",
  "errors.stage.invalidMotion": "The character motion settings are invalid.",
  "errors.stage.invalidMotionValue":
    "The character motion, speed, or amplitude is invalid.",
  "errors.history.invalidFormat": "The generation history format is invalid.",
  "errors.history.invalidField": "A generation history field is invalid.",
  "errors.history.invalidResume":
    "The history task recovery information is invalid.",
  "errors.history.invalidOwner":
    "The generation history result ownership is invalid.",
  "errors.history.invalidRequest": "The history request is invalid.",
  "errors.history.noMedia":
    "The history result has no media that can be saved.",
  "errors.history.waiting":
    "Waiting for an earlier task on the same service to finish.",
  "errors.history.querying": "Checking the original task progress.",
  "errors.history.cancelled": "The task was cancelled.",
  "errors.history.interrupted": "The service task was interrupted.",
  "errors.generationFailure.input":
    "The generation service rejected the input or parameters.",
  "errors.generationFailure.reference":
    "The generation service rejected the reference media.",
  "errors.generationFailure.authentication":
    "Generation service authentication failed. Check the API key in settings.",
  "errors.generationFailure.permission":
    "The generation service denied access. Check that the API key is correct and valid, and review model permissions and service security policies.",
  "errors.generationFailure.quota":
    "The model account balance or plan quota is insufficient.",
  "errors.generationFailure.rateLimit":
    "The model call rate or quota is limited. Try again later.",
  "errors.generationFailure.temporary":
    "The generation service is temporarily unavailable.",
  "errors.generationFailure.provider":
    "The generation service could not complete this operation.",
  "errors.generationFailure.submissionUnknown":
    "The submission result is unknown. Check with the provider before retrying.",
  "errors.generationFailure.local": "Preparing the local generation failed.",
  "errors.generationFailure.protocol":
    "The generation service returned an unrecognized or incomplete result.",
  "errors.generationFailure.download":
    "The generated result could not be downloaded.",
  "errors.generationFailure.notFoundTask":
    "The provider could not find this task.",
  "errors.generationFailure.notFoundEndpoint":
    "The generation endpoint or model does not exist.",
  "errors.generationFailure.cancelled":
    "The provider task was cancelled.",
  "errors.generationFailure.expired": "The provider task expired.",
  "errors.generationFailure.failed": "The generation task failed.",
  "errors.generationFailure.referenceAudio":
    "Audio reference cannot be used alone. Add a reference image.",
  "errors.generationFailure.referenceUnsupported":
    "The provider rejected the reference type or input combination.",
  "errors.generationFailure.privacy":
    "The provider rejected the reference image because it may contain a real person.",
  "errors.generationFailure.sensitiveInput":
    "The provider flagged the input as sensitive content and declined to generate. Change the prompt or reference media before generating again.",
  "errors.generationFailure.sensitiveOutput":
    "The provider flagged the generated content as sensitive and withheld it. Adjust the prompt or reference media before generating again.",
  "errors.history.failed":
    "Generation failed. Check the service log.",
  "errors.connection.endpointMissing": "The node no longer exists",
  "errors.connection.sourceEmpty":
    "This node has no content yet. Upload or generate content first.",
  "errors.connection.targetMaterial":
    "A media node cannot receive generation references. Connect a generation node.",
  "errors.connection.locked": "Unlock the node or its group first",
  "errors.connection.self": "A node cannot reference itself",
  "errors.connection.duplicate": "Already connected",
  "errors.connection.sourceType":
    "The target node does not accept this kind of media",
  "errors.connection.targetType": "This node does not accept references",
  "errors.connection.capacity": "The reference limit is reached",
  "errors.connection.frameCapacity":
    "First/last-frame mode accepts at most 2 image nodes. Disconnect the extra edges first.",
  "errors.connection.subjectMode":
    "A subject can contain one video, or one main image plus up to three extra images. Remove the conflicting media first.",
  "errors.connection.subjectCapacity":
    "A subject can contain one main image and three extra images",
  "errors.connection.subjectDuration":
    "Subject video cannot exceed 15 seconds",
  "errors.connection.sourceDuration":
    "Read the actual video or audio duration before adding it to the target node",
  "errors.timeline.libraryKind":
    "The timeline media library accepts only images, video, or audio.",
  "errors.timeline.kind":
    "The timeline accepts only images, video, or audio.",
  "errors.timeline.trackKind":
    "The media type does not match the target track.",
  "errors.timeline.duration":
    "Read the actual video or audio duration before adding it to the timeline.",
  "errors.timeline.finite": "The time position must be a finite number.",
  "errors.timeline.dropFinite": "The drop time must be a finite number.",
  "errors.timeline.dropTarget":
    "The dragged clip or target track could not be found.",
  "errors.timeline.sameKind": "Drop the clip on a track of the same kind.",
  "errors.timeline.playheadInside":
    "The playhead must be inside the selected clip.",
  "errors.timeline.importJson":
    "Choose a timeline JSON file exported by the local editor.",
  "errors.render.timelineEmpty": "Add media to the timeline first.",
  "errors.render.canvas": "Could not create the video frame.",
  "errors.render.missingMedia": "Media \"{title}\" has no file.",
  "errors.render.readFailed": "Could not read \"{title}\": {status}",
  "errors.render.imageDecode": "Could not decode image \"{title}\".",
  "errors.render.videoDecode": "Could not decode the video in \"{title}\".",
  "errors.render.audioDecode": "Could not decode the audio in \"{title}\".",
  "errors.render.noAudio": "\"{title}\" has no readable audio track.",
  "errors.render.noFrame":
    "\"{title}\" has no frame available at {time} seconds.",
  "errors.render.layerLocalOnly":
    "Only local images are supported. Import the file first; no external image is requested.",
  "errors.render.layerDecode":
    "Could not decode the layer image. Check the format or import the media again.",
  "errors.render.layerCanvas":
    "The browser cannot create a Canvas 2D layer canvas.",
  "errors.render.layerNotLoaded":
    "Layer \"{name}\" has not finished loading and cannot be composited.",
  "errors.render.layerNotPortable":
    "The image has not finished loading, so a portable layer file cannot be saved.",
  "errors.render.mp4Invalid":
    "The export duration or frame rate is invalid.",
  "errors.render.mp4Even":
    "MP4 width and height must be even. Adjust the timeline size.",
  "errors.render.mp4H264":
    "This browser cannot encode H.264 at this size. Use a browser with WebCodecs support or reduce the size.",
  "errors.render.aac":
    "Could not initialize AAC audio encoding. Reopen the page and try again.",
  "errors.render.noFile": "Video encoding did not return a file.",
  "errors.render.audioCrop": "The audio crop parameters are invalid.",
  "errors.render.audioLength": "The audio sample lengths do not match.",
  "errors.render.audioEmpty": "The audio crop range is empty.",
  "errors.render.audioSize":
    "The cropped WAV exceeds 256 MB. Shorten the range.",
  "errors.geometry.viewport": "Viewport dimensions must be positive.",
  "errors.geometry.padding": "Viewport padding must be non-negative.",
  "errors.geometry.arrange": "The arrange parameters are invalid.",
  "errors.hierarchy.duplicate": "Duplicate node id.",
  "errors.hierarchy.cycle": "The canvas group hierarchy contains a cycle.",
  "errors.hierarchy.parentMissing": "Parent node not found: {id}",
  "errors.example.create": "Could not create the example image.",
  "errors.files.read": "Could not read {name}",
  "errors.files.clipboardRead": "Could not read the media.",
  "errors.files.clipboardExpired":
    "The copied media has expired. Copy it again.",
  "errors.media.sharedTable": "The canvas shared-media table is invalid.",
  "errors.media.sharedMissing":
    "The canvas references shared media that does not exist.",
  "errors.refEvidence.editSource": "Edited result source",
  "errors.refEvidence.assemblySource":
    "Media assembly source (keeps the media version added at the time)",
  "errors.refEvidence.referenceSource": "Reference source",
  "errors.refEvidence.targetNode": "Target node",
  "errors.refEvidence.currentUsed":
    "The current result uses this reference",
  "errors.refEvidence.unknownInput": "No generation input recorded",
  "errors.refEvidence.missing": "Reference missing",
  "errors.refEvidence.pinnedDiff":
    "The pinned historical reference differs from the source's current content or the current result",
  "errors.refEvidence.pending": "Pending generation reference",
  "errors.refEvidence.pinnedNext":
    "; the next generation still uses the pinned historical media",
  "errors.refEvidence.current": "Current reference",
  "errors.refEvidence.currentUses": "Used by current result: ",
  "errors.refEvidence.notUsed": "This reference is not used",
  "errors.refEvidence.currentMaterial": "Source node's current media",
  "errors.refEvidence.historyMaterial": "Source node's historical media",
  "errors.refEvidence.nextUses": "Used by next generation: ",
  "errors.refEvidence.separator": ": ",
  "errors.refs.canvasMaterial": "Canvas media",
  "errors.refs.projectMaterial": "Project media",
  "errors.refs.tooLarge": "The file exceeds the reference size limit",
  "errors.refs.fallbackTitle": "Reference",
  "errors.imageAction.ink": "Could not draw the edit mark.",
  "errors.imageAction.canvas": "Could not create the edit reference image.",
  "errors.imageAction.limit":
    "The marks reached the save limit. Apply the local marks to generate an image before continuing.",
  "errors.import.readFailed": "Read failed",
  "errors.generation.targetMissing": "The target node no longer exists.",
  "errors.history.limit":
    "The history limit must be a positive integer.",
  "errors.stats.image": "Images",
  "errors.stats.video": "Video",
  "errors.stats.text": "Text",
  "errors.stats.audio": "Audio",
  "errors.stats.subject": "Subjects",
  "errors.stats.timeline": "Timelines",
  "errors.stats.group": "Groups",
  "errors.stats.all": "All",
  "errors.stats.tool": "Tools",
  "errors.stats.other": "Other",
  "errors.stats.upstream": "Upstream nodes",
  "errors.tool.unknown": "Unknown tool.",
  "errors.tool.version": "The task parameter version is not supported.",
  "errors.tool.duplicateSource": "Source nodes cannot repeat.",
  "errors.tool.sources": "Choose {range} source media items.",
  "errors.tool.sourceMissing":
    "Source media is missing, or its media type does not match the tool.",
  "errors.tool.fieldRequired": "Set {label}.",
  "errors.tool.fieldNumber": "{label} must be a valid {type}.",
  "errors.tool.integer": "integer",
  "errors.tool.number": "number",
  "errors.tool.fieldBoolean": "{label} must be a boolean.",
  "errors.tool.fieldSelect":
    "{label} is not one of the options available for this capability.",
  "errors.tool.fieldFormat": "{label} has an invalid format.",
  "errors.tool.fieldColor":
    "{label} must be a lowercase hexadecimal color.",
  "errors.tool.multiPreset":
    "The preset aspect ratio output size must match the measured size.",
  "errors.tool.multiCustom":
    "Custom sizes need positive integer width and height; the supported range is still unconfirmed.",
  "errors.tool.videoDurationUnknown":
    "The video duration cannot be confirmed. Read the source media's actual duration first.",
  "errors.tool.videoDurationRange":
    "Video editing supports only 4–30 second media.",
  "errors.tool.videoPrompt": "Enter the video editing prompt.",
  "errors.tool.splitPrompt":
    "Description-based splitting needs a split description.",
  "errors.tool.outpaintDirection": "Extend at least one direction.",
  "errors.tool.outpaintFixed":
    "Outpainting always produces one 2K image, and the long edge must match the output size.",
  "errors.tool.lightBrightness":
    "Lighting brightness must be an integer from the capability list.",
  "errors.tool.layerFormat":
    "Layer decomposition supports only known input formats: PNG / JPEG.",
  "errors.tool.layerPixels":
    "Layer decomposition needs an image with at least 262,144 pixels.",
  "errors.tool.maskRequired":
    "Edit and provide a valid selection mask first.",
  "errors.tool.maskOwner":
    "The selection does not belong to the current source node. Edit the selection again.",
  "errors.tool.selectionSize":
    "Selection width and height must be positive integers.",
  "errors.tool.maskSize":
    "The mask size must match the source image size.",
  "errors.tool.productRegion":
    "Select the product region in the original scene.",
  "errors.tool.boxesRequired":
    "Box-based splitting needs rectangle selections in the source image.",
  "errors.tool.regionOut":
    "The product region is outside the source image or has an invalid size.",
  "errors.tool.splitRegionOut":
    "The split region is outside the source image or has an invalid size.",
  "errors.tool.entryOnly":
    "This tool's parameter protocol is not connected yet; the task cannot be submitted.",
  "errors.tool.draftFormat":
    "The tool task draft format is invalid.",
  "errors.tool.draftVersion":
    "The tool task draft version or tool is not supported.",
  "errors.tool.draftSource": "The tool task source is invalid.",
  "errors.tool.draftParameters": "The tool task parameters are invalid.",
  "errors.tool.paramLimit":
    "The number of tool parameters exceeds the limit.",
  "errors.tool.paramValue": "A tool parameter contains an invalid value.",
  "errors.tool.selectionFormat": "The selection format is invalid.",
  "errors.tool.selectionSource":
    "The selection source or size is invalid.",
  "errors.tool.maskInvalid": "The selection mask is invalid.",
  "errors.tool.boxInvalid": "The selection rectangle data is invalid.",
  "errors.tool.boxSize": "The selection rectangle size is invalid.",
  "errors.catalog.noteSmartEdit":
    "Smart-edit model; local smart-edit capabilities such as brushes are not connected.",
  "errors.catalog.noteVip":
    "The original site shows VIP; selecting it locally does not grant model service.",
  "errors.catalog.noteFirstLast":
    "First/last-frame mode only; text-to-video works without references. Only the 5-second parameter has been verified so far.",
  "errors.catalog.sampleName": "Seedance 2.5 Sample",
  "errors.catalog.sampleNote":
    "The 480P sample entry has been observed; the duration range for normal generation is unverified.",
  "errors.catalog.noteVipParams":
    "The original site shows VIP; normal generation parameters are unverified.",
  "errors.catalog.noteEntryParams":
    "The model entry has been observed; normal generation parameters are unverified.",
  "errors.catalog.context2K": "2K · 1 image",
  "errors.catalog.contextOmni": "Omni reference · 4 s · 720P · 1 clip",
  "errors.catalog.contextFirstLast":
    "First/last frame · 5 s · 720P · 1 clip",
  "errors.catalog.contextMusic": "Music generation · 30 s · measured in this run",
  "errors.catalog.contextVoice":
    "SpongeBob voice read · measured with this input, not priced per character",
} as const;
