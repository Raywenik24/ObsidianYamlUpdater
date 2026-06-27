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

// PreviewNote runs ops in-memory on one note; returns before/after frontmatter text.
func (a *App) PreviewNote(notePath string, operations []ops.Op) (map[string]string, error) {
	note, err := a.findNote(notePath)
	if err != nil {
		return nil, err
	}
	editSet, _ := ops.BuildEdits(operations, note.Fields, note.Meta)
	before, after := vault.Preview(note, editSet)
	return map[string]string{
		"before": strings.Join(before, "\n"),
		"after":  strings.Join(after, "\n"),
	}, nil
}

// DryRun evaluates ops against all selected notes without writing.
func (a *App) DryRun(notePaths []string, operations []ops.Op) ([]ops.Verdict, error) {
	notes, err := a.resolveNotes(notePaths)
	if err != nil {
		return nil, err
	}
	out := make([]ops.Verdict, len(notes))
	for i, n := range notes {
		out[i] = ops.DryRun(n, operations)
	}
	return out, nil
}

// ApplyOps applies ops and writes every changed note; also writes a .log file.
func (a *App) ApplyOps(notePaths []string, operations []ops.Op) ([]ops.Verdict, error) {
	notes, err := a.resolveNotes(notePaths)
	if err != nil {
		return nil, err
	}
	out := make([]ops.Verdict, len(notes))
	for i, n := range notes {
		out[i] = ops.Apply(n, operations)
	}
	a.writeLog(out, operations)
	return out, nil
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
