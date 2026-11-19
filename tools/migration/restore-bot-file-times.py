"""Restore one newly created private bot file's timestamp through its pinned FD.

Run with Python isolated mode. No live SQLite, bot state mutation or cleanup.
"""
import os
import stat
import sys


def main():
    if len(sys.argv) != 5:
        raise ValueError('Expected private file identity and original timestamp')
    path, device, inode, mtime = sys.argv[1:]
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
                or stat.S_IMODE(before.st_mode) != 0o600
                or before.st_uid != os.getuid()
                or (before.st_dev, before.st_ino) != (int(device), int(inode))):
            raise ValueError('Private bot file identity differs')
        target = int(mtime)
        os.utime(fd, ns=(before.st_atime_ns, target))
        os.fsync(fd)
        after, named = os.fstat(fd), os.lstat(path)
        if (after.st_mtime_ns != target
                or (after.st_dev, after.st_ino, after.st_size, after.st_mode,
                    after.st_uid, after.st_nlink)
                != (before.st_dev, before.st_ino, before.st_size, before.st_mode,
                    before.st_uid, before.st_nlink)
                or (named.st_dev, named.st_ino) != (after.st_dev, after.st_ino)):
            raise ValueError('Private bot timestamp was not preserved exactly')
    finally:
        os.close(fd)


if __name__ == '__main__':
    main()
