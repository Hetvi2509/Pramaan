"""Runtime hook: use the real pkg_resources when it is on disk, otherwise a minimal stand-in.

The build ships setuptools/pkg_resources as plain files beside the engine (see desktop/stage.mjs), because
bundling them through PyInstaller breaks on setuptools' vendored jaraco/backports. paddle imports
setuptools.command.easy_install, which needs the real pkg_resources. The fallback covers only
face_recognition_models, which calls pkg_resources.resource_filename and nothing else.
"""
import importlib
import os
import sys
import types

try:
    import pkg_resources  # noqa: F401
except Exception:
    sys.modules.pop("pkg_resources", None)
    shim = types.ModuleType("pkg_resources")

    def resource_filename(package, resource):
        module = sys.modules.get(package) or importlib.import_module(package)
        return os.path.join(os.path.dirname(os.path.abspath(module.__file__)), resource)

    shim.resource_filename = resource_filename
    sys.modules["pkg_resources"] = shim
