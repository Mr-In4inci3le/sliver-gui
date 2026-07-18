package main

import (
	"bytes"
	"compress/gzip"
	"testing"

	"github.com/bishopfox/sliver/protobuf/clientpb"
	"github.com/bishopfox/sliver/protobuf/sliverpb"
	"google.golang.org/protobuf/proto"
)

func TestRandSuffix(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 1000; i++ {
		s := randSuffix()
		if len(s) == 0 {
			t.Fatal("randSuffix returned empty string")
		}
		if seen[s] {
			t.Fatalf("randSuffix collision on %q within 1000 draws", s)
		}
		seen[s] = true
	}
}

func TestSchemeOf(t *testing.T) {
	cases := map[string]string{
		"https://1.2.3.4:8443": "https",
		"mtls://host:8888":     "mtls",
		"dns://example.com":    "dns",
		"1.2.3.4:8888":         "",
		"":                     "",
	}
	for in, want := range cases {
		if got := schemeOf(in); got != want {
			t.Errorf("schemeOf(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestFormatFromString(t *testing.T) {
	cases := map[string]clientpb.OutputFormat{
		"shared":    clientpb.OutputFormat_SHARED_LIB,
		"service":   clientpb.OutputFormat_SERVICE,
		"shellcode": clientpb.OutputFormat_SHELLCODE,
		"exe":       clientpb.OutputFormat_EXECUTABLE,
		"":          clientpb.OutputFormat_EXECUTABLE,
	}
	for in, want := range cases {
		if got := formatFromString(in); got != want {
			t.Errorf("formatFromString(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestParseCSVLine(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{`a,b,c`, []string{"a", "b", "c"}},
		{`"a,b",c`, []string{"a,b", "c"}},
		{`"he said ""hi""",x`, []string{`he said "hi"`, "x"}},
		{``, []string{""}},
		{`,,`, []string{"", "", ""}},
	}
	for _, c := range cases {
		got := parseCSVLine(c.in)
		if len(got) != len(c.want) {
			t.Errorf("parseCSVLine(%q) len = %d, want %d (%q)", c.in, len(got), len(c.want), got)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("parseCSVLine(%q)[%d] = %q, want %q", c.in, i, got[i], c.want[i])
			}
		}
	}
}

func TestParseExecuteResponse(t *testing.T) {
	// Empty -> placeholder.
	if out, _ := parseExecuteResponse(nil); out != "(no output)" {
		t.Errorf("empty response = %q, want (no output)", out)
	}
	// Valid protobuf round-trips stdout/stderr.
	data, err := proto.Marshal(&sliverpb.Execute{
		Stdout: []byte("hello"),
		Stderr: []byte("oops"),
	})
	if err != nil {
		t.Fatal(err)
	}
	out, errStr := parseExecuteResponse(data)
	if out != "hello" || errStr != "oops" {
		t.Errorf("parseExecuteResponse = (%q,%q), want (hello,oops)", out, errStr)
	}
}

func TestDecodeDownload(t *testing.T) {
	// Plain (no encoder) passes through.
	if got, err := decodeDownload(&sliverpb.Download{Data: []byte("raw")}); err != nil || string(got) != "raw" {
		t.Errorf("plain decode = (%q,%v), want (raw,nil)", got, err)
	}
	// gzip encoder is inflated.
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	zw.Write([]byte("compressed payload"))
	zw.Close()
	got, err := decodeDownload(&sliverpb.Download{Encoder: "gzip", Data: buf.Bytes()})
	if err != nil || string(got) != "compressed payload" {
		t.Errorf("gzip decode = (%q,%v), want (compressed payload,nil)", got, err)
	}
}
