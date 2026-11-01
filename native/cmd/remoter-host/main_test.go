package main

import "testing"

func TestUpdateLANToken(t *testing.T) {
	first, err := updateLANToken("")
	if err != nil {
		t.Fatal(err)
	}
	second, err := updateLANToken("")
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("normal starts must revoke previous LAN access")
	}
	resumed, err := updateLANToken(first)
	if err != nil || resumed != first {
		t.Fatal("update must retain existing LAN access")
	}
	if _, err := updateLANToken("invalid"); err == nil {
		t.Fatal("invalid handoff accepted")
	}
}
