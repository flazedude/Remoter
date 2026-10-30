package platform

import "testing"

func TestSyntheticHasNoNativeDependency(t *testing.T) {
	s := NewSynthetic()
	ds, err := s.Displays()
	if err != nil || len(ds) != 1 {
		t.Fatal(ds, err)
	}
	im, err := s.Capture(0)
	if err != nil || im.Bounds().Dx() != 1280 {
		t.Fatal(err)
	}
	if _, err := s.Capture(1); err == nil {
		t.Fatal("invalid display accepted")
	}
	if err := ValidateEvent(InputEvent{Type: "move", X: 1279, Y: 719}, ds); err != nil {
		t.Fatal(err)
	}
	if err := ValidateEvent(InputEvent{Type: "move", X: -1}, ds); err == nil {
		t.Fatal("negative coordinate accepted")
	}
}
