package ops

import (
	"strings"

	"ObsidianYamlUpdater/internal/vault"
)

type OpKind string

const (
	OpAdd        OpKind = "add"
	OpSet        OpKind = "set"
	OpDelete     OpKind = "delete"
	OpRename     OpKind = "rename"
	OpListAdd    OpKind = "list-add"
	OpListRemove OpKind = "list-remove"
)

type CondKind string

const (
	CondKeyExists     CondKind = "key_exists"
	CondKeyMissing    CondKind = "key_missing"
	CondValueEquals   CondKind = "value_equals"
	CondValueContains CondKind = "value_contains"
)

type Condition struct {
	Kind  CondKind `json:"kind"`
	Key   string   `json:"key"`
	Value string   `json:"value"`
}

type Op struct {
	Kind  OpKind      `json:"kind"`
	Key   string      `json:"key"`
	Value string      `json:"value"`
	Conds []Condition `json:"conds"`
}

type Verdict struct {
	Path    string   `json:"path"`
	Status  string   `json:"status"`
	Reason  string   `json:"reason"`
	Changes []string `json:"changes"`
}

// Evaluate checks all conditions. Returns true if the op should apply.
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

// BuildEdits converts ops into an EditSet.
// meta is note.Meta and is used to make rename list-aware.
func BuildEdits(ops []Op, fields map[string]string, meta map[string]vault.FieldMeta) (set vault.EditSet, skipped []string) {
	set = vault.EditSet{
		Scalar:  map[string]string{},
		List:    map[string][]vault.ListMutation{},
		Renames: map[string]string{},
	}
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
				set.Scalar[op.Key] = op.Value
				working[op.Key] = op.Value
			} else {
				skipped = append(skipped, "add "+op.Key+" (key exists)")
			}
		case OpSet:
			set.Scalar[op.Key] = op.Value
			working[op.Key] = op.Value
		case OpDelete:
			set.Scalar[op.Key] = ""
			delete(working, op.Key)
		case OpRename:
			if _, exists := working[op.Key]; exists {
				set.Renames[op.Key] = op.Value
				delete(working, op.Key)
				working[op.Value] = ""
			}
		case OpListAdd:
			set.List[op.Key] = append(set.List[op.Key], vault.ListMutation{Item: op.Value, Add: true})
		case OpListRemove:
			set.List[op.Key] = append(set.List[op.Key], vault.ListMutation{Item: op.Value, Add: false})
		}
	}
	return set, skipped
}

func (k OpKind) String() string { return string(k) }

// DryRun runs ops against a note in-memory, returns a Verdict without writing.
func DryRun(note vault.Note, ops []Op) Verdict {
	set, _ := BuildEdits(ops, note.Fields, note.Meta)
	before, after := vault.Preview(note, set)
	changes := diffFrontmatter(note.Fields, note.Meta, before, after)
	if len(changes) == 0 {
		return Verdict{Path: note.Rel, Status: "skipped", Reason: "no changes"}
	}
	return Verdict{Path: note.Rel, Status: "changed", Changes: changes}
}

// Apply runs ops and writes the file. Returns a Verdict with the outcome.
func Apply(note vault.Note, ops []Op) Verdict {
	set, skips := BuildEdits(ops, note.Fields, note.Meta)
	if len(set.Scalar) == 0 && len(set.List) == 0 && len(set.Renames) == 0 {
		reason := "no changes"
		if len(skips) > 0 {
			reason = "skipped: " + strings.Join(skips, "; ")
		}
		return Verdict{Path: note.Rel, Status: "skipped", Reason: reason}
	}

	changes, err := vault.Apply(note, set)
	if err != nil {
		return Verdict{Path: note.Rel, Status: "error", Reason: err.Error()}
	}
	if len(changes) == 0 {
		return Verdict{Path: note.Rel, Status: "skipped", Reason: "no changes"}
	}
	return Verdict{Path: note.Rel, Status: "changed", Changes: changes}
}

func diffFrontmatter(beforeFields map[string]string, beforeMeta map[string]vault.FieldMeta, before, after []string) []string {
	afterFields, afterMeta, _ := vault.ParseFrontmatter(after)

	var changes []string

	for k, v := range afterFields {
		afm := afterMeta[k]
		if afm.IsList {
			bfm, exists := beforeMeta[k]
			if !exists {
				changes = append(changes, "added: "+k)
			} else {
				bi := bfm.Items
				if bi == nil {
					bi = []string{}
				}
				ai := afm.Items
				if ai == nil {
					ai = []string{}
				}
				if !itemsEqual(bi, ai) {
					changes = append(changes, "set: "+k)
				}
			}
			continue
		}
		bv, exists := beforeFields[k]
		if !exists {
			changes = append(changes, "added: "+k)
		} else if bv != v {
			changes = append(changes, "set: "+k)
		}
	}

	for k := range beforeFields {
		if _, exists := afterFields[k]; !exists {
			changes = append(changes, "deleted: "+k)
		}
	}

	return changes
}

func itemsEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
