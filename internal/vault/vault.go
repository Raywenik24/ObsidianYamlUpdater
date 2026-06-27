package vault

import (
	"bytes"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Note holds the parsed state of one .md file.
type Note struct {
	Path   string            // absolute path
	Rel    string            // path relative to vault root
	Title  string            // filename without extension
	Fields map[string]string // parsed frontmatter key → raw value (scalar or first line of block)
	Lines  []string          // all file lines (for surgical rewrite)
	FMEnd  int               // line index of the closing "---" (exclusive boundary)
	CRLF   bool              // true if the file uses CRLF line endings
}

// Scan walks root recursively and returns all readable .md notes.
// Unreadable files (locked, OneDrive placeholder) are logged to errOut and skipped.
func Scan(root string, errOut func(path string, err error)) ([]Note, error) {
	var notes []Note
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if path == root {
				return err // fatal: can't open the root itself
			}
			errOut(path, err)
			return nil
		}
		if d.IsDir() || !strings.EqualFold(filepath.Ext(path), ".md") {
			return nil
		}
		note, err := parseFile(path, root)
		if err != nil {
			errOut(path, err)
			return nil
		}
		notes = append(notes, note)
		return nil
	})
	return notes, err
}

// parseFile reads and parses one .md file.
func parseFile(path, root string) (Note, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Note{}, err
	}

	crlf := bytes.Contains(data, []byte("\r\n"))
	normalized := strings.ReplaceAll(string(data), "\r\n", "\n")
	lines := strings.Split(normalized, "\n")

	rel, _ := filepath.Rel(root, path)
	title := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))

	fields, fmEnd := parseFrontmatter(lines)
	return Note{
		Path:   path,
		Rel:    rel,
		Title:  title,
		Fields: fields,
		Lines:  lines,
		FMEnd:  fmEnd,
		CRLF:   crlf,
	}, nil
}

// parseFrontmatter extracts key→value pairs from the opening --- block.
// Returns the fields map and the line index just after the closing ---.
func parseFrontmatter(lines []string) (map[string]string, int) {
	fields := map[string]string{}
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return fields, 0
	}
	for i := 1; i < len(lines); i++ {
		line := lines[i]
		if strings.TrimSpace(line) == "---" {
			return fields, i + 1
		}
		if idx := strings.Index(line, ":"); idx > 0 {
			key := strings.TrimSpace(line[:idx])
			val := strings.TrimSpace(line[idx+1:])
			if _, exists := fields[key]; !exists { // first occurrence wins
				fields[key] = val
			}
		}
	}
	return fields, len(lines)
}

// Apply writes the note back to disk with the given field edits applied surgically.
// edits maps key → new raw value (empty string = delete the key).
// Returns the lines that actually changed (for logging).
func Apply(note Note, edits map[string]string) (changed []string, err error) {
	if note.FMEnd == 0 {
		// No frontmatter — nothing to rewrite
		return nil, nil
	}

	lines := make([]string, len(note.Lines))
	copy(lines, note.Lines)

	// Track which keys we've already handled
	handled := map[string]bool{}

	for i := 1; i < note.FMEnd-1; i++ {
		line := lines[i]
		idx := strings.Index(line, ":")
		if idx <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:idx])
		newVal, targeted := edits[key]
		if !targeted {
			continue
		}
		handled[key] = true
		if newVal == "" {
			// Delete: mark line for removal
			lines[i] = "\x00"
			changed = append(changed, "deleted: "+key)
		} else {
			oldLine := line
			lines[i] = key + ": " + newVal
			if lines[i] != oldLine {
				changed = append(changed, "set: "+key)
			}
		}
	}

	// Add new keys (those in edits but not found in frontmatter)
	var additions []string
	for key, val := range edits {
		if !handled[key] && val != "" {
			additions = append(additions, key+": "+val)
			changed = append(changed, "added: "+key)
		}
	}

	// Remove deleted lines
	var out []string
	for _, l := range lines {
		if l != "\x00" {
			out = append(out, l)
		}
	}

	// Insert additions before the closing ---
	if len(additions) > 0 {
		// Find closing --- in the trimmed lines
		closeIdx := -1
		for i := 1; i < len(out); i++ {
			if strings.TrimSpace(out[i]) == "---" {
				closeIdx = i
				break
			}
		}
		if closeIdx >= 0 {
			out = append(out[:closeIdx], append(additions, out[closeIdx:]...)...)
		}
	}

	if len(changed) == 0 {
		return nil, nil
	}

	return changed, atomicWrite(note.Path, out, note.CRLF)
}

// Preview runs the same edit logic as Apply but returns the resulting lines without writing.
func Preview(note Note, edits map[string]string) (before []string, after []string) {
	// before = just the frontmatter lines
	if note.FMEnd > 0 {
		before = note.Lines[0:note.FMEnd]
	}

	lines := make([]string, len(note.Lines))
	copy(lines, note.Lines)
	handled := map[string]bool{}

	for i := 1; i < note.FMEnd-1; i++ {
		line := lines[i]
		idx := strings.Index(line, ":")
		if idx <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:idx])
		newVal, targeted := edits[key]
		if !targeted {
			continue
		}
		handled[key] = true
		if newVal == "" {
			lines[i] = "\x00"
		} else {
			lines[i] = key + ": " + newVal
		}
	}

	var additions []string
	for key, val := range edits {
		if !handled[key] && val != "" {
			additions = append(additions, key+": "+val)
		}
	}

	var out []string
	for _, l := range lines {
		if l != "\x00" {
			out = append(out, l)
		}
	}

	if len(additions) > 0 {
		for i := 1; i < len(out); i++ {
			if strings.TrimSpace(out[i]) == "---" {
				out = append(out[:i], append(additions, out[i:]...)...)
				break
			}
		}
	}

	if note.FMEnd > 0 {
		after = out[0 : note.FMEnd+len(additions)]
	}
	return before, after
}

func atomicWrite(path string, lines []string, crlf bool) error {
	sep := "\n"
	if crlf {
		sep = "\r\n"
	}
	content := strings.Join(lines, sep)

	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".yamlupdater-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()

	_, err = tmp.WriteString(content)
	tmp.Close()
	if err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		os.Remove(tmpName)
		return err
	}
	return nil
}

// ReadFull reads a note from disk (used to refresh after apply).
func ReadFull(path, root string) (Note, error) {
	return parseFile(path, root)
}

