package vault

import (
	"bytes"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// FieldMeta holds parsed list metadata for a frontmatter field.
type FieldMeta struct {
	IsList    bool
	Items     []string // nil for scalar fields
	Format    string   // "block" | "inline" | ""
	LineStart int      // line index of the "key:" line
	LineEnd   int      // exclusive: line after last item line
}

// ListMutation describes a single list-add or list-remove for one item.
type ListMutation struct {
	Item string
	Add  bool // true = add, false = remove
}

// EditSet bundles all edits for Apply/Preview.
type EditSet struct {
	Scalar  map[string]string       // key → new value; empty string = delete
	List    map[string][]ListMutation
	Renames map[string]string // old key → new key (rename in-place, preserves list format)
}

// Note holds the parsed state of one .md file.
type Note struct {
	Path   string
	Rel    string
	Title  string
	Fields map[string]string   // key → raw scalar value (empty for block lists)
	Meta   map[string]FieldMeta
	Lines  []string
	FMEnd  int
	CRLF   bool
}

// Scan walks root recursively and returns all readable .md notes.
func Scan(root string, errOut func(path string, err error)) ([]Note, error) {
	var notes []Note
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if path == root {
				return err
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

	fields, meta, fmEnd := parseFrontmatter(lines)
	return Note{
		Path:   path,
		Rel:    rel,
		Title:  title,
		Fields: fields,
		Meta:   meta,
		Lines:  lines,
		FMEnd:  fmEnd,
		CRLF:   crlf,
	}, nil
}

// parseFrontmatter extracts key→value pairs and list metadata from the opening --- block.
func parseFrontmatter(lines []string) (map[string]string, map[string]FieldMeta, int) {
	fields := map[string]string{}
	meta := map[string]FieldMeta{}
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return fields, meta, 0
	}
	i := 1
	for i < len(lines) {
		line := lines[i]
		if strings.TrimSpace(line) == "---" {
			return fields, meta, i + 1
		}
		idx := strings.Index(line, ":")
		if idx > 0 {
			key := strings.TrimSpace(line[:idx])
			val := strings.TrimSpace(line[idx+1:])
			if _, exists := fields[key]; !exists {
				fm := FieldMeta{LineStart: i}
				switch {
				case val == "":
					items, end := parseBlockItems(lines, i+1)
					if len(items) > 0 {
						fm.IsList = true
						fm.Items = items
						fm.Format = "block"
						fm.LineEnd = end
						fields[key] = ""
						meta[key] = fm
						i = end
						continue
					}
					fm.LineEnd = i + 1
					fields[key] = val
				case strings.HasPrefix(val, "[") && strings.HasSuffix(val, "]"):
					items := parseInlineItems(val[1 : len(val)-1])
					fm.IsList = true
					fm.Items = items
					fm.Format = "inline"
					fm.LineEnd = i + 1
					fields[key] = val
				default:
					fm.LineEnd = i + 1
					fields[key] = val
				}
				meta[key] = fm
			}
		}
		i++
	}
	return fields, meta, len(lines)
}

// ParseFrontmatter is exported for use by ops when diffing previews.
func ParseFrontmatter(lines []string) (map[string]string, map[string]FieldMeta, int) {
	return parseFrontmatter(lines)
}

func parseBlockItems(lines []string, start int) ([]string, int) {
	var items []string
	i := start
	for i < len(lines) {
		t := strings.TrimSpace(lines[i])
		if strings.HasPrefix(t, "- ") {
			items = append(items, strings.TrimPrefix(t, "- "))
			i++
		} else if t == "-" {
			items = append(items, "")
			i++
		} else {
			break
		}
	}
	return items, i
}

func parseInlineItems(inner string) []string {
	if strings.TrimSpace(inner) == "" {
		return []string{}
	}
	var items []string
	for _, s := range strings.Split(inner, ",") {
		items = append(items, strings.TrimSpace(s))
	}
	return items
}

// Apply writes the note back to disk with the given edits applied surgically.
func Apply(note Note, set EditSet) (changed []string, err error) {
	if note.FMEnd == 0 {
		return nil, nil
	}
	out, changed := computeLines(note, set)
	if len(changed) == 0 {
		return nil, nil
	}
	return changed, atomicWrite(note.Path, out, note.CRLF)
}

// Preview runs the same edit logic as Apply but returns lines without writing.
func Preview(note Note, set EditSet) (before []string, after []string) {
	if note.FMEnd > 0 {
		before = note.Lines[0:note.FMEnd]
	}
	out, _ := computeLines(note, set)
	// find frontmatter end in result
	if len(out) > 0 && strings.TrimSpace(out[0]) == "---" {
		for i := 1; i < len(out); i++ {
			if strings.TrimSpace(out[i]) == "---" {
				after = out[:i+1]
				return
			}
		}
	}
	return
}

// computeLines applies all edits and returns the full resulting line slice.
func computeLines(note Note, set EditSet) ([]string, []string) {
	lines := make([]string, len(note.Lines))
	copy(lines, note.Lines)

	var changed []string
	handled := map[string]bool{}

	// blockSetQueue: after removing old items, insert this single item after the key line.
	blockSetQueue := map[string]string{}

	for i := 1; i < note.FMEnd-1; i++ {
		line := lines[i]
		idx := strings.Index(line, ":")
		if idx <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:idx])
		newVal, targeted := set.Scalar[key]
		if !targeted {
			continue
		}
		handled[key] = true
		fm := note.Meta[key]

		if newVal == "" {
			// Delete: sentinel key line + any block item lines
			lines[i] = "\x00"
			if fm.IsList && fm.Format == "block" {
				for j := fm.LineStart + 1; j < fm.LineEnd && j < len(lines); j++ {
					lines[j] = "\x00"
				}
			}
			changed = append(changed, "deleted: "+key)
		} else if fm.IsList {
			// Set on a list field: replace items, keep field as a list
			if fm.Format == "block" {
				// Key line stays ("key:"), clear old item lines, new item inserted after
				for j := fm.LineStart + 1; j < fm.LineEnd && j < len(lines); j++ {
					lines[j] = "\x00"
				}
				blockSetQueue[key] = newVal
			} else {
				// Inline: replace with single-item list
				lines[i] = key + ": [" + newVal + "]"
			}
			changed = append(changed, "set: "+key)
		} else {
			oldLine := line
			lines[i] = key + ": " + newVal
			if lines[i] != oldLine {
				changed = append(changed, "set: "+key)
			}
		}
	}

	// New scalar keys not yet in frontmatter
	var additions []string
	for key, val := range set.Scalar {
		if !handled[key] && val != "" {
			additions = append(additions, key+": "+val)
			changed = append(changed, "added: "+key)
		}
	}

	// Remove sentinel lines
	var out []string
	for _, l := range lines {
		if l != "\x00" {
			out = append(out, l)
		}
	}

	// Insert block-set item lines right after their key line
	for key, item := range blockSetQueue {
		for i, l := range out {
			ix := strings.Index(l, ":")
			if ix > 0 && strings.TrimSpace(l[:ix]) == key {
				out = sliceInsert(out, i+1, []string{"  - " + item})
				break
			}
		}
	}

	// Insert scalar additions before closing ---
	if len(additions) > 0 {
		if ci := findFMClose(out); ci >= 0 {
			out = sliceInsert(out, ci, additions)
		}
	}

	// Renames: find old key line and rename it in-place (preserves list structure)
	for oldKey, newKey := range set.Renames {
		for i, l := range out {
			ix := strings.Index(l, ":")
			if ix > 0 && strings.TrimSpace(l[:ix]) == oldKey {
				out[i] = newKey + l[ix:] // keep everything after the key name
				changed = append(changed, "renamed: "+oldKey)
				break
			}
		}
	}

	// List mutations
	for key, muts := range set.List {
		var ch string
		out, ch = applyListMutations(out, note.Meta, key, muts)
		if ch != "" {
			changed = append(changed, ch)
		}
	}

	return out, changed
}

func applyListMutations(lines []string, meta map[string]FieldMeta, key string, muts []ListMutation) ([]string, string) {
	fm, hasMeta := meta[key]

	var currentItems []string
	var format string
	var keyLineIdx int

	if hasMeta && fm.IsList {
		currentItems = make([]string, len(fm.Items))
		copy(currentItems, fm.Items)
		format = fm.Format
		keyLineIdx = fm.LineStart
	} else if hasMeta && !fm.IsList {
		// scalar field: only convert on add
		hasAdd := false
		for _, m := range muts {
			if m.Add {
				hasAdd = true
				break
			}
		}
		if !hasAdd {
			return lines, ""
		}
		line := lines[fm.LineStart]
		ix := strings.Index(line, ":")
		existing := ""
		if ix >= 0 {
			existing = strings.TrimSpace(line[ix+1:])
		}
		if existing != "" {
			currentItems = []string{existing}
		}
		format = "inline"
		keyLineIdx = fm.LineStart
	} else {
		// key absent: only act on add
		hasAdd := false
		for _, m := range muts {
			if m.Add {
				hasAdd = true
				break
			}
		}
		if !hasAdd {
			return lines, ""
		}
		format = "inline"
		keyLineIdx = -1
	}

	origItems := append([]string(nil), currentItems...)
	for _, m := range muts {
		currentItems = applyOneItemMutation(currentItems, m.Item, m.Add)
	}

	if itemsEqual(origItems, currentItems) && hasMeta {
		return lines, ""
	}

	action := "list-add: " + key
	for _, m := range muts {
		if !m.Add {
			action = "list-remove: " + key
			break
		}
	}

	if keyLineIdx < 0 {
		newLine := formatInlineList(key, currentItems)
		ci := findFMClose(lines)
		if ci < 0 {
			return lines, ""
		}
		return sliceInsert(lines, ci, []string{newLine}), action
	}

	if format == "inline" {
		newLines := make([]string, len(lines))
		copy(newLines, lines)
		newLines[keyLineIdx] = formatInlineList(key, currentItems)
		return newLines, action
	}

	// Block format: scan for actual key line position (may have shifted)
	actualKeyIdx := -1
	for i, l := range lines {
		ix := strings.Index(l, ":")
		if ix > 0 && strings.TrimSpace(l[:ix]) == key {
			actualKeyIdx = i
			break
		}
	}
	if actualKeyIdx < 0 {
		return lines, ""
	}
	endIdx := actualKeyIdx + 1
	for endIdx < len(lines) && strings.HasPrefix(strings.TrimSpace(lines[endIdx]), "-") {
		endIdx++
	}
	var itemLines []string
	for _, item := range currentItems {
		itemLines = append(itemLines, "  - "+item)
	}
	newLines := make([]string, 0, len(lines)-(endIdx-(actualKeyIdx+1))+len(itemLines))
	newLines = append(newLines, lines[:actualKeyIdx+1]...)
	newLines = append(newLines, itemLines...)
	newLines = append(newLines, lines[endIdx:]...)
	return newLines, action
}

func applyOneItemMutation(items []string, item string, add bool) []string {
	if add {
		for _, e := range items {
			if e == item {
				return items
			}
		}
		return append(items, item)
	}
	var result []string
	for _, e := range items {
		if e != item {
			result = append(result, e)
		}
	}
	if result == nil {
		result = []string{}
	}
	return result
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

func formatInlineList(key string, items []string) string {
	return key + ": [" + strings.Join(items, ", ") + "]"
}

func findFMClose(lines []string) int {
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			return i
		}
	}
	return -1
}

func sliceInsert(s []string, at int, vals []string) []string {
	result := make([]string, 0, len(s)+len(vals))
	result = append(result, s[:at]...)
	result = append(result, vals...)
	result = append(result, s[at:]...)
	return result
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
