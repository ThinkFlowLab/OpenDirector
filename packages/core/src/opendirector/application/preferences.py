"""Application preferences shared by the workbench and background generation."""

from opendirector.ports.gateway import gateway


class Preferences:
    def __init__(self, repository):
        self.store = gateway().settings(repository)

    def get(self):
        return self.store.get()

    def update(self, value):
        return self.store.update(value)
