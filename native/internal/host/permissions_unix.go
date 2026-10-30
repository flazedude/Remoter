//go:build !windows

package host

import "os"

func restrictPath(path string, dir bool) error {
	if dir {
		return os.Chmod(path, 0700)
	}
	return os.Chmod(path, 0600)
}
