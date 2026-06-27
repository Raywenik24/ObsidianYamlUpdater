package ops

import (
	"strings"

	"ObsidianYamlUpdater/internal/vault"
)

type OpKind string

const (
	OpAdd    OpKind = "add"    // add key=val (if missing)
	OpSet    OpKind = "set"    // set key=val (create or overwrite)
	OpDelete OpKind = "delete" // remove key
	OpRename OpKind = "rename" // rename key, keep value
)

type CondKind string

const (
	CondKeyExists   CondKind = "key_exists"
	CondKeyMissing  CondKind = "key_missing"
	CondValueEquals CondKind = "value_equals"
	CondValueContains CondKind = "value_contains"
)

type Condition struct {
	Kind  CondKind `json:"kind"`
	Key   string   `json:"key"`
	Value string   `json:"value"` // used by equals/contains
}

type Op struct {
	Kind     OpKind      `json:"kind"`
	Key      string      `json:"key"`
	Value    string      `json:"value"`    // new value (or new key name for rename)
	Conds    []Condition `json:"conds"`
}

type Verdict struct {
	Path    string   `json:"path"`
	Status  string   `json:"status"`  // "changed" | "skipped" | "error"
	Reason  string   `json:"reason"`  // skipped/error detail
	Changes []string `json:"changes"` // e.g. ["added: foo", "deleted: bar"]
}

// Evaluate checks all conditions for a note. Returns true if the op should apply.
func Evaluate(conds []Condition, fields map[string]string) bool {
	for _, c := range conds {
		val, exists := fields[c.Key]
		switch c.Kind {
		case CondKeyExists:
			if !exists {
				return false
			}
		case CondKeyMissing:
			if exists {
				return false
			}
		case CondValueEquals:
			if !strings.EqualFold(val, c.Value) {
				return false
			}
		case CondValueContains:
			if !strings.Contains(strings.ToLower(val), strings.ToLower(c.Value)) {
				return false
			}
		}
	}
	return true
}

// BuildEdits converts an ordered list of ops into a key→value edit map
// (empty value = delete), applied in order so later ops override earlier ones.
// Returns the edit map and a slice of skip reasons for ops whose conditions failed.
func BuildEdits(ops []Op, fields map[string]string) (edits map[string]string, skipped []string) {
	edits = map[string]string{}
	// work on a copy of fields so ops see each other's changes
	working := map[string]string{}
	for k, v := range fields {
		working[k] = v
	}

	for _, op := range ops {
		if !Evaluate(op.Conds, working) {
			skipped = append(skipped, op.Kind.String()+" "+op.Key+" (condition)")
			continue
		}
		switch op.Kind {
		case OpAdd:
			if _, exists := working[op.Key]; !exists {
				edits[op.Key] = op.Value
				working[op.Key] = op.Value
			}
		case OpSet:
			edits[op.Key] = op.Value
			working[op.Key] = op.Value
		case OpDelete:
			edits[op.Key] = "" // empty = delete in Apply
			delete(working, op.Key)
		case OpRename:
			if v, exists := working[op.Key]; exists {
				edits[op.Key] = ""  // delete old
				edits[op.Value] = v // add new (Value = new key name)
				delete(working, op.Key)
				working[op.Value] = v
			}
		}
	}
	return edits, skipped
}

func (k OpKind) String() string { return string(k) }

// DryRun runs ops against a note in-memory, returns a Verdict without writing.
func DryRun(note vault.Note, ops []Op) Verdict {
	edits, _ := BuildEdits(ops, note.Fields)
	_, after := vault.Preview(note, edits)

	// Determine what changed by comparing before/after frontmatter
	changes := diffFrontmatter(note.Fields, after)
	if len(changes) == 0 {
		return Verdict{Path: note.Rel, Status: "skipped", Reason: "no changes"}
	}
	return Verdict{Path: note.Rel, Status: "changed", Changes: changes}
}

// Apply runs ops and writes the file. Returns a Verdict with the outcome.
func Apply(note vault.Note, ops []Op) Verdict {
	edits, skips := BuildEdits(ops, note.Fields)
	if len(edits) == 0 {
		reason := "no changes"
		if len(skips) > 0 {
			reason = "skipped: " + strings.Join(skips, "; ")
		}
		return Verdict{Path: note.Rel, Status: "skipped", Reason: reason}
	}

	changes, err := vault.Apply(note, edits)
	if err != nil {
		return Verdict{Path: note.Rel, Status: "error", Reason: err.Error()}
	}
	if len(changes) == 0 {
		return Verdict{Path: note.Rel, Status: "skipped", Reason: "no changes"}
	}
	return Verdict{Path: note.Rel, Status: "changed", Changes: changes}
}

func diffFrontmatter(before map[string]string, afterLines []string) []string {
	// Rebuild a fields map from afterLines for comparison
	after := map[string]string{}
	for _, l := range afterLines {
		if idx := strings.Index(l, ":"); idx > 0 {
			k := strings.TrimSpace(l[:idx])
			v := strings.TrimSpace(l[idx+1:])
			after[k] = v
		}
	}

	var changes []string
	for k, v := range after {
		bv, exists := before[k]
		if !exists {
			changes = append(changes, "added: "+k)
		} else if bv != v {
			changes = append(changes, "set: "+k)
		}
	}
	for k := range before {
		if _, exists := after[k]; !exists {
			changes = append(changes, "deleted: "+k)
		}
	}
	return changes
}
