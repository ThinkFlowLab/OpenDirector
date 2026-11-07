"""Pure indexes over a project snapshot."""


def object_index(snapshot):
    result = {('project', snapshot.project.id): snapshot.project}
    for kind, collection in [('asset', snapshot.assets), ('generation_spec', snapshot.generationSpecs),
            ('reference', snapshot.references), ('canvas_item', snapshot.canvasItems),
            ('editor_document', snapshot.editorDocuments), ('job', snapshot.jobs), ('result', snapshot.results)]:
        result.update({(kind, item.id): item for item in collection})
    return result
