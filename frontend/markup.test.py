import unittest
from html.parser import HTMLParser
from pathlib import Path


class WorkspaceMarkup(HTMLParser):
    void_tags = {
        "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
        "meta", "param", "source", "track", "wbr",
    }

    def __init__(self):
        super().__init__()
        self.stack = []
        self.errors = []
        self.dialog_parents = {}

    def handle_starttag(self, tag, attributes):
        attributes = dict(attributes)
        classes = attributes.get("class", "").split()
        if "modal" in classes or "modal-overlay" in classes:
            self.dialog_parents[attributes.get("id")] = list(self.stack)
        if tag not in self.void_tags:
            self.stack.append(tag)

    def handle_endtag(self, tag):
        if tag in self.void_tags:
            return
        if self.stack and self.stack[-1] == tag:
            self.stack.pop()
        else:
            self.errors.append((self.getpos(), tag, self.stack[-1:]))


class WorkspaceMarkupTests(unittest.TestCase):
    def setUp(self):
        self.markup = WorkspaceMarkup()
        self.markup.feed(Path(__file__).with_name("index.html").read_text())

    def test_containers_have_matching_end_tags(self):
        self.assertEqual(self.markup.errors, [])
        self.assertEqual(self.markup.stack, [])

    def test_dialogs_are_not_trapped_inside_hidden_parent_dialogs(self):
        self.assertIn("remote-shutdown-modal", self.markup.dialog_parents)
        for dialog, parents in self.markup.dialog_parents.items():
            with self.subTest(dialog=dialog):
                self.assertEqual(parents, ["html", "body"])


if __name__ == "__main__":
    unittest.main()
