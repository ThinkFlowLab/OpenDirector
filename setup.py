"""One distribution, retaining the core/API source boundaries."""
from setuptools import Distribution, find_packages, setup
from setuptools.command.bdist_wheel import bdist_wheel


class BundledDistribution(Distribution):
    def has_ext_modules(self):
        # The bundled OpenCode executable belongs to this build host's platform.
        return True


class PlatformWheel(bdist_wheel):
    def get_tag(self):
        return 'py3', 'none', super().get_tag()[2]


setup(
    packages=find_packages('packages/core/src') + find_packages('apps/api/src'),
    package_dir={'opendirector': 'packages/core/src/opendirector',
                 'opendirector_api': 'apps/api/src/opendirector_api'},
    package_data={'opendirector': ['_bundled/**/*'], 'opendirector_api': ['example-canvases.json']},
    include_package_data=True,
    distclass=BundledDistribution,
    cmdclass={'bdist_wheel': PlatformWheel},
)
