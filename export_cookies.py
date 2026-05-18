"""
Export club.com cookies from Chrome to cookies.json
Run this ONCE before using the bot. Chrome must be running (or closed).

Usage: python export_cookies.py
"""
import os
import json
import shutil
import sqlite3
import base64
import tempfile
from pathlib import Path

# ── Windows DPAPI + AES decryption for Chrome v80+ cookies ───────────────────
import ctypes
import ctypes.wintypes

LOCAL_STATE = Path(os.environ["LOCALAPPDATA"]) / "Google/Chrome/User Data/Local State"
COOKIES_DB = Path(os.environ["LOCALAPPDATA"]) / "Google/Chrome/User Data/Default/Network/Cookies"


def dpapi_decrypt(ciphertext: bytes) -> bytes:
    class DATA_BLOB(ctypes.Structure):
        _fields_ = [("cbData", ctypes.wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    p = ctypes.create_string_buffer(ciphertext, len(ciphertext))
    blobin = DATA_BLOB(ctypes.sizeof(p), p)
    blobout = DATA_BLOB()
    retval = ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(blobin), None, None, None, None, 0, ctypes.byref(blobout)
    )
    if not retval:
        raise RuntimeError("DPAPI decryption failed")
    result = ctypes.string_at(blobout.pbData, blobout.cbData)
    ctypes.windll.kernel32.LocalFree(blobout.pbData)
    return result


def get_chrome_key() -> bytes:
    local_state = json.loads(LOCAL_STATE.read_text(encoding="utf-8"))
    encrypted_key = base64.b64decode(local_state["os_crypt"]["encrypted_key"])
    # Strip "DPAPI" prefix
    encrypted_key = encrypted_key[5:]
    return dpapi_decrypt(encrypted_key)


def decrypt_cookie_value(key: bytes, encrypted_value: bytes) -> str:
    from Crypto.Cipher import AES
    if encrypted_value[:3] == b"v10" or encrypted_value[:3] == b"v11":
        nonce = encrypted_value[3:3+12]
        ciphertext = encrypted_value[3+12:-16]
        tag = encrypted_value[-16:]
        cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
        try:
            return cipher.decrypt_and_verify(ciphertext, tag).decode("utf-8", errors="replace")
        except Exception:
            return ""
    # Legacy DPAPI
    try:
        return dpapi_decrypt(encrypted_value).decode("utf-8", errors="replace")
    except Exception:
        return ""


def _copy_locked_file(src: Path, dst: str):
    """Copy a file that is locked by another process using Windows shared-access CreateFile."""
    import ctypes
    import ctypes.wintypes as wt

    GENERIC_READ = 0x80000000
    FILE_SHARE_READ = 0x1
    FILE_SHARE_WRITE = 0x2
    FILE_SHARE_DELETE = 0x4
    OPEN_EXISTING = 3
    FILE_FLAG_BACKUP_SEMANTICS = 0x02000000

    handle = ctypes.windll.kernel32.CreateFileW(
        str(src),
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        None, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, None
    )
    INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
    if handle == INVALID_HANDLE_VALUE:
        err = ctypes.GetLastError()
        raise PermissionError(f"Cannot open locked file (err={err}): {src}")

    try:
        file_size = ctypes.c_int64(0)
        ctypes.windll.kernel32.GetFileSizeEx(handle, ctypes.byref(file_size))
        size = file_size.value
        chunk = 65536
        with open(dst, "wb") as f:
            remaining = size
            while remaining > 0:
                to_read = min(chunk, remaining)
                buf = ctypes.create_string_buffer(to_read)
                read = wt.DWORD(0)
                ctypes.windll.kernel32.ReadFile(handle, buf, to_read, ctypes.byref(read), None)
                if read.value == 0:
                    break
                f.write(buf.raw[:read.value])
                remaining -= read.value
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)


def extract_cookies(domain: str = "club.com") -> list[dict]:
    key = get_chrome_key()

    # Copy DB + WAL to temp (SQLite WAL mode: data may be in -wal file)
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as tmp:
        tmp_path = tmp.name
    wal_path = tmp_path + "-wal"
    shm_path = tmp_path + "-shm"
    try:
        _copy_locked_file(COOKIES_DB, tmp_path)
    except Exception:
        shutil.copy2(COOKIES_DB, tmp_path)
    # Copy WAL if exists
    wal_src = Path(str(COOKIES_DB) + "-wal")
    shm_src = Path(str(COOKIES_DB) + "-shm")
    if wal_src.exists():
        try:
            _copy_locked_file(wal_src, wal_path)
        except Exception:
            try: shutil.copy2(wal_src, wal_path)
            except Exception: pass
    if shm_src.exists():
        try:
            _copy_locked_file(shm_src, shm_path)
        except Exception:
            try: shutil.copy2(shm_src, shm_path)
            except Exception: pass

    cookies = []
    try:
        con = sqlite3.connect(f"file:{tmp_path}?mode=ro", uri=True)
        cur = con.cursor()
        # Check what tables exist
        tables = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
        print(f"  Tables: {tables}")
        table = "cookies" if "cookies" in tables else tables[0] if tables else None
        if not table:
            print("  No tables found in cookie DB")
            return []
        cols = [r[1] for r in cur.execute(f"PRAGMA table_info({table})").fetchall()]
        print(f"  Columns: {cols}")
        cur.execute(
            f"SELECT name, encrypted_value, host_key, path, expires_utc, is_secure, is_httponly "
            f"FROM {table} WHERE host_key LIKE ?",
            (f"%{domain}%",),
        )
        for name, enc_val, host, path, expires, secure, httponly in cur.fetchall():
            value = decrypt_cookie_value(key, enc_val)
            cookies.append({
                "name": name,
                "value": value,
                "domain": host,
                "path": path,
                "secure": bool(secure),
                "httpOnly": bool(httponly),
            })
        cur.close()
        con.close()
    finally:
        for p in [tmp_path, wal_path, shm_path]:
            try:
                os.unlink(p)
            except Exception:
                pass

    return cookies


if __name__ == "__main__":
    print("Extracting club.com cookies from Chrome...")
    try:
        from Crypto.Cipher import AES  # noqa: F401
    except ImportError:
        print("Installing pycryptodome...")
        os.system("uv pip install pycryptodome -q")
        from Crypto.Cipher import AES  # noqa: F401

    cookies = extract_cookies("club.com")
    if not cookies:
        print("No cookies found for club.com — make sure you're logged in on Chrome")
        exit(1)

    out = Path(__file__).parent / "cookies.json"
    out.write_text(json.dumps(cookies, indent=2))
    print(f"Exported {len(cookies)} cookies → {out}")
    for c in cookies:
        print(f"  {c['name']}: {c['value'][:40]}...")
