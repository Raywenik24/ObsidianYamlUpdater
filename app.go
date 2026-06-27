package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"ObsidianYamlUpdater/internal/ops"
	"ObsidianYamlUpdater/internal/vault"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type App struct {
	ctx       context.Context
	vaultRoot string
	notes     []vault.Note
}

func NewApp() *App { return &App{} }

func (a *App) startup(ctx context.Context) { a.ctx = ctx }

// PickVault opens a native folder dialog and returns the chosen path.
func (a *App) PickVault() (string, error) {
	dir, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select Obsidian vault folder",
	})
	if err != nil || dir == "" {
		return "", err
	}
	a.vaultRoot = dir
	return dir, nil
}

// NoteInfo is what the frontend receives per note.
type NoteInfo struct {
	Path   string            `json:"path"`
	Rel    string            `json:"rel"`
	Title  string            `json:"title"`
	Fields map[string]string `json:"fields"`
}

// Scan walks the vault and returns NoteInfo for every readable .md file.
func (a *App) Scan(root string) ([]NoteInfo, error) {
	if root == "" {
		root = a.vaultRoot
	}
	if root == "" {
		return nil, fmt.Errorf("no vault folder selected")
	}
	a.vaultRoot = root

	notes, err := vault.Scan(root, func(path string, e error) {
		rel, _ := filepath.Rel(root, path)
		_ = rel // scan errors visible via wails dev console
		_ = e
	})
	if err != nil {
		return nil, err
	}
	a.notes = notes

	out := make([]NoteInfo, 0, len(notes))
	for _, n := range notes {
		out = append(out, NoteInfo{
			Path:   n.Path,
			Rel:    n.Rel,
			Title:  n.Title,
			Fields: n.Fields,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Rel < out[j].Rel })
	return out, nil
}

// normalizeFolderConds converts absolute folder condition values to vault-relative paths.
// This lets users paste an absolute path from Explorer rather than a relative one.
func (a *App) normalizeFolderConds(operations []ops.Op) []ops.Op {
	if a.vaultRoot == "" {
		return operations
	}
	folderKinds := map[ops.CondKind]bool{
		ops.CondInFolder:             true,
		ops.CondInFolderRecursive:    true,
		ops.CondNotInFolder:          true,
		ops.CondNotInFolderRecursive: true,
	}
	out := make([]ops.Op, len(operations))
	for i, op := range operations {
		conds := make([]ops.Condition, len(op.Conds))
		for j, c := range op.Conds {
			if folderKinds[c.Kind] && filepath.IsAbs(c.Value) {
				if rel, err := filepath.Rel(a.vaultRoot, c.Value); err == nil {
					c.Value = filepath.ToSlash(rel)
				}
			}
			conds[j] = c
		}
		op.Conds = conds
		out[i] = op
	}
	return out
}

// PreviewNote runs ops in-memory on one note; returns before/after frontmatter text.
func (a *App) PreviewNote(notePath string, operations []ops.Op) (map[string]string, error) {
	note, err := a.findNote(notePath)
	if err != nil {
		return nil, err
	}
	operations = a.normalizeFolderConds(operations)
	editSet, skipped := ops.BuildEdits(operations, note.Fields, note.Meta, note.Rel)
	before, after := vault.Preview(note, editSet)
	return map[string]string{
		"before":  strings.Join(before, "\n"),
		"after":   strings.Join(after, "\n"),
		"skipped": strings.Join(skipped, "; "),
	}, nil
}

// DryRun evaluates ops against all selected notes without writing.
func (a *App) DryRun(notePaths []string, operations []ops.Op) ([]ops.Verdict, error) {
	notes, err := a.resolveNotes(notePaths)
	if err != nil {
		return nil, err
	}
	operations = a.normalizeFolderConds(operations)
	out := make([]ops.Verdict, len(notes))
	for i, n := range notes {
		out[i] = ops.DryRun(n, operations)
	}
	return out, nil
}

// UndoEntry records one key's before/after state for a single apply run.
type UndoEntry struct {
	Path string `json:"path"`
	Key  string `json:"key"`
	Old  string `json:"old"` // scalar: old value; list: JSON-encoded []string; "" = key didn't exist
	New  string `json:"new"` // scalar: new value; list: JSON-encoded []string; "" = key deleted
}

// ApplyOps applies ops and writes every changed note; also writes a .log and .undo.json file.
func (a *App) ApplyOps(notePaths []string, operations []ops.Op) ([]ops.Verdict, error) {
	notes, err := a.resolveNotes(notePaths)
	if err != nil {
		return nil, err
	}
	operations = a.normalizeFolderConds(operations)
	out := make([]ops.Verdict, len(notes))
	var undoEntries []UndoEntry

	for i, n := range notes {
		out[i] = ops.Apply(n, operations)
		if out[i].Status == "changed" {
			newNote, rerr := vault.ReadFull(n.Path, a.vaultRoot)
			if rerr == nil {
				undoEntries = append(undoEntries, buildUndoEntries(n.Path, n.Fields, n.Meta, newNote.Fields, newNote.Meta)...)
			}
		}
	}

	if len(undoEntries) > 0 {
		a.writeUndo(undoEntries)
	}
	a.writeLog(out, operations)
	return out, nil
}

// GetUndoable returns the path of the most recent unused .undo.json file, or "" if none.
func (a *App) GetUndoable() (string, error) {
	dir := "."
	if exe, err := os.Executable(); err == nil {
		dir = filepath.Dir(exe)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", err
	}
	var best string
	for _, e := range entries {
		name := e.Name()
		if strings.HasSuffix(name, ".undo.json") {
			full := filepath.Join(dir, name)
			if full > best {
				best = full
			}
		}
	}
	return best, nil
}

// UndoLastRun reads the most recent undo file and reverses every change it recorded.
func (a *App) UndoLastRun() ([]ops.Verdict, error) {
	path, err := a.GetUndoable()
	if err != nil {
		return nil, err
	}
	if path == "" {
		return nil, fmt.Errorf("no undo file available")
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var entries []UndoEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		return nil, err
	}

	byPath := map[string][]UndoEntry{}
	var pathOrder []string
	for _, e := range entries {
		if _, seen := byPath[e.Path]; !seen {
			pathOrder = append(pathOrder, e.Path)
		}
		byPath[e.Path] = append(byPath[e.Path], e)
	}

	var verdicts []ops.Verdict
	for _, notePath := range pathOrder {
		note, rerr := vault.ReadFull(notePath, a.vaultRoot)
		if rerr != nil {
			verdicts = append(verdicts, ops.Verdict{Path: notePath, Status: "error", Reason: rerr.Error()})
			continue
		}
		editSet := buildUndoEditSet(byPath[notePath])
		changed, aerr := vault.Apply(note, editSet)
		if aerr != nil {
			verdicts = append(verdicts, ops.Verdict{Path: notePath, Status: "error", Reason: aerr.Error()})
			continue
		}
		if len(changed) == 0 {
			verdicts = append(verdicts, ops.Verdict{Path: notePath, Status: "skipped", Reason: "no changes"})
		} else {
			verdicts = append(verdicts, ops.Verdict{Path: notePath, Status: "changed", Changes: changed})
		}
	}

	_ = os.Rename(path, path+".done")
	return verdicts, nil
}

func (a *App) findNote(path string) (vault.Note, error) {
	for _, n := range a.notes {
		if n.Path == path {
			return n, nil
		}
	}
	if a.vaultRoot == "" {
		return vault.Note{}, fmt.Errorf("note not found: %s", path)
	}
	return vault.ReadFull(path, a.vaultRoot)
}

func (a *App) resolveNotes(paths []string) ([]vault.Note, error) {
	set := map[string]bool{}
	for _, p := range paths {
		set[p] = true
	}
	out := make([]vault.Note, 0, len(paths))
	found := map[string]bool{}
	for _, n := range a.notes {
		if set[n.Path] {
			out = append(out, n)
			found[n.Path] = true
		}
	}
	for _, p := range paths {
		if !found[p] {
			n, err := vault.ReadFull(p, a.vaultRoot)
			if err != nil {
				return nil, fmt.Errorf("cannot read %s: %w", p, err)
			}
			out = append(out, n)
		}
	}
	return out, nil
}

func (a *App) presetsDir() (string, error) {
	dir := "presets"
	if exe, err := os.Executable(); err == nil {
		dir = filepath.Join(filepath.Dir(exe), "presets")
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", err
	}
	return dir, nil
}

func (a *App) ListPresets() ([]string, error) {
	dir, err := a.presetsDir()
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	names := []string{}
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".json") {
			names = append(names, strings.TrimSuffix(e.Name(), ".json"))
		}
	}
	sort.Strings(names)
	return names, nil
}

func (a *App) SavePreset(name string, operations []ops.Op) error {
	dir, err := a.presetsDir()
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(operations, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, name+".json"), data, 0644)
}

func (a *App) LoadPreset(name string) ([]ops.Op, error) {
	dir, err := a.presetsDir()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(filepath.Join(dir, name+".json"))
	if err != nil {
		return nil, err
	}
	var operations []ops.Op
	if err := json.Unmarshal(data, &operations); err != nil {
		return nil, err
	}
	return operations, nil
}

func (a *App) DeletePreset(name string) error {
	dir, err := a.presetsDir()
	if err != nil {
		return err
	}
	return os.Remove(filepath.Join(dir, name+".json"))
}

func buildUndoEntries(notePath string, bFields map[string]string, bMeta map[string]vault.FieldMeta, aFields map[string]string, aMeta map[string]vault.FieldMeta) []UndoEntry {
	var entries []UndoEntry
	seen := map[string]bool{}

	for key := range aFields {
		seen[key] = true
		afm := aMeta[key]
		bfm, bExists := bMeta[key]

		if afm.IsList || (bExists && bfm.IsList) {
			var oldItems, newItems []string
			if bExists && bfm.IsList {
				oldItems = bfm.Items
				if oldItems == nil {
					oldItems = []string{}
				}
			}
			if afm.IsList {
				newItems = afm.Items
				if newItems == nil {
					newItems = []string{}
				}
			}
			if !undoItemsEqual(oldItems, newItems) {
				oldJSON, _ := json.Marshal(oldItems)
				newJSON, _ := json.Marshal(newItems)
				entries = append(entries, UndoEntry{Path: notePath, Key: key, Old: string(oldJSON), New: string(newJSON)})
			}
		} else {
			bVal := bFields[key]
			aVal := aFields[key]
			if !bExists {
				entries = append(entries, UndoEntry{Path: notePath, Key: key, Old: "", New: aVal})
			} else if bVal != aVal {
				entries = append(entries, UndoEntry{Path: notePath, Key: key, Old: bVal, New: aVal})
			}
		}
	}

	for key := range bFields {
		if seen[key] {
			continue
		}
		bfm := bMeta[key]
		if bfm.IsList {
			items := bfm.Items
			if items == nil {
				items = []string{}
			}
			oldJSON, _ := json.Marshal(items)
			entries = append(entries, UndoEntry{Path: notePath, Key: key, Old: string(oldJSON), New: "null"})
		} else {
			entries = append(entries, UndoEntry{Path: notePath, Key: key, Old: bFields[key], New: ""})
		}
	}
	return entries
}

func buildUndoEditSet(entries []UndoEntry) vault.EditSet {
	set := vault.EditSet{
		Scalar:  map[string]string{},
		List:    map[string][]vault.ListMutation{},
		Renames: map[string]string{},
	}
	for _, e := range entries {
		isListEntry := strings.HasPrefix(e.Old, "[") || strings.HasPrefix(e.New, "[") || e.New == "null"
		if isListEntry {
			var oldItems, newItems []string
			if e.Old != "" && e.Old != "null" {
				_ = json.Unmarshal([]byte(e.Old), &oldItems)
			}
			if e.New != "" && e.New != "null" {
				_ = json.Unmarshal([]byte(e.New), &newItems)
			}
			newSet := map[string]bool{}
			for _, item := range newItems {
				newSet[item] = true
			}
			for _, item := range oldItems {
				if !newSet[item] {
					set.List[e.Key] = append(set.List[e.Key], vault.ListMutation{Item: item, Add: true})
				}
			}
			oldSet := map[string]bool{}
			for _, item := range oldItems {
				oldSet[item] = true
			}
			for _, item := range newItems {
				if !oldSet[item] {
					set.List[e.Key] = append(set.List[e.Key], vault.ListMutation{Item: item, Add: false})
				}
			}
		} else {
			set.Scalar[e.Key] = e.Old
		}
	}
	return set
}

func undoItemsEqual(a, b []string) bool {
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

func (a *App) writeUndo(entries []UndoEntry) {
	ts := time.Now().Format("20060102-150405")
	path := filepath.Join(".", fmt.Sprintf("ObsidianYamlUpdater-%s.undo.json", ts))
	if exe, err := os.Executable(); err == nil {
		path = filepath.Join(filepath.Dir(exe), fmt.Sprintf("ObsidianYamlUpdater-%s.undo.json", ts))
	}
	data, _ := json.MarshalIndent(entries, "", "  ")
	_ = os.WriteFile(path, data, 0644)
}

func (a *App) writeLog(verdicts []ops.Verdict, operations []ops.Op) {
	ts := time.Now().Format("20060102-150405")
	logPath := filepath.Join(".", fmt.Sprintf("ObsidianYamlUpdater-%s.log", ts))
	if exe, err := os.Executable(); err == nil {
		logPath = filepath.Join(filepath.Dir(exe), fmt.Sprintf("ObsidianYamlUpdater-%s.log", ts))
	}

	var sb strings.Builder
	sb.WriteString("ObsidianYamlUpdater — " + time.Now().Format("2006-01-02 15:04:05") + "\n")
	sb.WriteString("Vault: " + a.vaultRoot + "\n\nOperations:\n")
	for _, op := range operations {
		sb.WriteString(fmt.Sprintf("  [%s] key=%q value=%q conds=%d\n", op.Kind, op.Key, op.Value, len(op.Conds)))
	}
	sb.WriteString("\nResults:\n")
	var changed, skipped, errored int
	for _, v := range verdicts {
		switch v.Status {
		case "changed":
			changed++
			sb.WriteString(fmt.Sprintf("  CHANGED  %s — %s\n", v.Path, strings.Join(v.Changes, ", ")))
		case "skipped":
			skipped++
			sb.WriteString(fmt.Sprintf("  SKIPPED  %s — %s\n", v.Path, v.Reason))
		case "error":
			errored++
			sb.WriteString(fmt.Sprintf("  ERROR    %s — %s\n", v.Path, v.Reason))
		}
	}
	sb.WriteString(fmt.Sprintf("\nSummary: %d changed, %d skipped, %d errors\n", changed, skipped, errored))
	_ = os.WriteFile(logPath, []byte(sb.String()), 0644)
}
