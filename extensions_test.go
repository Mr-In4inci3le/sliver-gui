package main

import "testing"

func TestPackArgs_MissingRequired(t *testing.T) {
	cmd := &extCommand{Arguments: []extArg{
		{Name: "target", Type: "string"},
	}}
	if _, err := packArgs(cmd, nil); err == nil {
		t.Fatal("expected error for missing required argument, got nil")
	}
}

func TestPackArgs_OptionalSkipped(t *testing.T) {
	cmd := &extCommand{Arguments: []extArg{
		{Name: "opt", Type: "string", Optional: true},
	}}
	if _, err := packArgs(cmd, nil); err != nil {
		t.Fatalf("optional argument should be skippable, got %v", err)
	}
}

func TestPackArgs_IntValidation(t *testing.T) {
	cmd := &extCommand{Arguments: []extArg{
		{Name: "n", Type: "int"},
	}}
	if _, err := packArgs(cmd, []string{"notanumber"}); err == nil {
		t.Fatal("expected error for non-integer int arg, got nil")
	}
	if _, err := packArgs(cmd, []string{"42"}); err != nil {
		t.Fatalf("valid int arg failed: %v", err)
	}
}

func TestPackArgs_UnsupportedType(t *testing.T) {
	cmd := &extCommand{Arguments: []extArg{
		{Name: "x", Type: "bogus"},
	}}
	if _, err := packArgs(cmd, []string{"v"}); err == nil {
		t.Fatal("expected error for unsupported arg type, got nil")
	}
}

func TestPackArgs_StringOK(t *testing.T) {
	cmd := &extCommand{Arguments: []extArg{
		{Name: "s", Type: "string"},
	}}
	buf, err := packArgs(cmd, []string{"hello"})
	if err != nil {
		t.Fatalf("string arg failed: %v", err)
	}
	if len(buf) == 0 {
		t.Fatal("expected non-empty packed buffer")
	}
}
