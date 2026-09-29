# dvr-scan-py/pyi_rth_paddlex.py (VERIFIED & OPTIMIZED VERSION)
"""
PyInstaller runtime hook for PaddleX and PaddleOCR.
This hook solves runtime issues by:
1. Pre-injecting cv2 and pyclipper into builtins BEFORE any patched imports are active.
2. Disabling PaddleX dependency checking that fails in frozen builds.
3. Fixing dataclasses module for transformers compatibility (Python 3.13+).
"""
import sys
import builtins

if hasattr(sys, '_MEIPASS'):
    print("[Niriksha Hook] Initializing runtime patches...")
    
    # --- Fix dataclasses.__version__ for transformers (Python 3.13+) ---
    try:
        import dataclasses
        if not hasattr(dataclasses, '__version__'):
            # transformers expects dataclasses.__version__ but Python 3.13+ stdlib doesn't have it
            dataclasses.__version__ = "0.8"  # Use a reasonable version string
            print("[Niriksha Hook] Added dataclasses.__version__ for transformers compatibility.")
    except ImportError:
        pass
    
    # --- Disable TorchScript JIT compilation in frozen builds ---
    try:
        import torch.jit
        _original_torch_jit_script = torch.jit.script
        
        def patched_torch_jit_script(obj, *args, **kwargs):
            """
            In PyInstaller builds, TorchScript cannot access source code.
            Return the original function instead of trying to compile it.
            """
            # If it's a function, just return it as-is
            if callable(obj):
                return obj
            # Otherwise try the original behavior
            return _original_torch_jit_script(obj, *args, **kwargs)
        
        torch.jit.script = patched_torch_jit_script
        print("[Niriksha Hook] Disabled TorchScript JIT compilation (incompatible with PyInstaller).")
    except ImportError:
        pass
    
    # --- Patch inspect module to handle missing source code ---
    try:
        import inspect
        _original_getsource = inspect.getsource
        _original_getsourcelines = inspect.getsourcelines
        
        def patched_getsource(obj):
            """Return empty string instead of raising OSError when source is unavailable."""
            try:
                return _original_getsource(obj)
            except (OSError, TypeError):
                # Return minimal valid source code
                return "# Source code unavailable in frozen build\n"
        
        def patched_getsourcelines(obj):
            """Return empty lines instead of raising OSError when source is unavailable."""
            try:
                return _original_getsourcelines(obj)
            except (OSError, TypeError):
                # Return empty source with line number 0
                return (["# Source code unavailable in frozen build\n"], 0)
        
        inspect.getsource = patched_getsource
        inspect.getsourcelines = patched_getsourcelines
        print("[Niriksha Hook] Patched inspect.getsource/getsourcelines for PyInstaller compatibility.")
    except ImportError:
        pass
    
    # Store the original import function.
    _original_import = builtins.__import__
    
    # --- CRITICAL: Inject modules IMMEDIATELY using the original, un-patched import ---
    try:
        cv2_module = _original_import('cv2')
        builtins.cv2 = cv2_module
        print("[Niriksha Hook] Injected `cv2` into builtins.")
    except ImportError as e:
        print(f"[Niriksha Hook WARNING] Could not pre-inject cv2: {e}")
    
    try:
        pyclipper_module = _original_import('pyclipper')
        builtins.pyclipper = pyclipper_module
        print("[Niriksha Hook] Injected `pyclipper` into builtins.")
    except ImportError as e:
        print(f"[Niriksha Hook WARNING] Could not pre-inject pyclipper: {e}")
    
    # --- Now, define and apply the patch for dependency checking ---
    _patch_applied = False
    
    def patched_import(name, globals=None, locals=None, fromlist=(), level=0):
        global _patch_applied
        
        # Always call the original import function first - let it handle everything normally
        try:
            module = _original_import(name, globals, locals, fromlist, level)
        except Exception:
            # If original import fails, re-raise it - don't try to fix it
            raise
        
        # Apply the dependency check patch only once when paddlex.utils.deps is imported
        if name == 'paddlex.utils.deps' and not _patch_applied:
            deps_module = sys.modules.get('paddlex.utils.deps')
            if deps_module and not getattr(deps_module, '_pyi_patched', False):
                def no_op_check(*args, **kwargs): 
                    return None
                
                # Patch all known dependency check functions
                for func_name in ['require_extra', 'require_deps', 'check_deps']:
                    if hasattr(deps_module, func_name):
                        setattr(deps_module, func_name, no_op_check)
                
                deps_module._pyi_patched = True
                _patch_applied = True
                print("[Niriksha Hook] PaddleX dependency checking has been disabled.")
        
        return module
    
    # Finally, replace the built-in import with our patched version.
    builtins.__import__ = patched_import
    print("[Niriksha Hook] Import patching is now active.")