//go:build windows

package host

import "golang.org/x/sys/windows"

func restrictPath(path string, dir bool) error {
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	flags := ""
	if dir {
		flags = "OICI"
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;" + flags + ";FA;;;" + u.User.Sid.String() + ")(A;" + flags + ";FA;;;SY)")
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
}
