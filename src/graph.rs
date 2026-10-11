//! Lane layout for the commit graph.
//!
//! Commits arrive in topological order (children before parents). We keep a list of
//! "lanes", each waiting for a particular commit sha. Every row produces a node plus the
//! line segments the frontend needs to draw, so the browser does no graph logic at all.

use crate::git::Commit;
use serde::Serialize;

/// Vertical anchor of a segment end inside a row.
pub const TOP: u8 = 0;
pub const MID: u8 = 1;
pub const BOTTOM: u8 = 2;

#[derive(Debug, Serialize, PartialEq)]
pub struct Segment {
    pub x1: usize,
    pub y1: u8,
    pub x2: usize,
    pub y2: u8,
    pub color: usize,
}

#[derive(Debug, Serialize)]
pub struct Row {
    #[serde(flatten)]
    pub commit: Commit,
    pub col: usize,
    pub color: usize,
    pub segments: Vec<Segment>,
}

#[derive(Debug, Serialize)]
pub struct Graph {
    pub rows: Vec<Row>,
    pub width: usize,
}

#[derive(Clone)]
struct Lane {
    sha: String,
    color: usize,
}

pub fn layout(commits: Vec<Commit>) -> Graph {
    let mut lanes: Vec<Option<Lane>> = Vec::new();
    let mut next_color = 0usize;
    let mut width = 0usize;
    let mut rows = Vec::with_capacity(commits.len());
    let new_color = |next: &mut usize| {
        let c = *next;
        *next += 1;
        c
    };

    for commit in commits {
        let mut segments = Vec::new();

        // 1. Which column is this commit in? The left-most lane waiting for it, else a free slot.
        let waiting: Vec<usize> = lanes
            .iter()
            .enumerate()
            .filter_map(|(i, l)| l.as_ref().filter(|l| l.sha == commit.sha).map(|_| i))
            .collect();
        let (col, color) = match waiting.first() {
            Some(&c) => (c, lanes[c].as_ref().unwrap().color),
            None => (free_slot(&mut lanes), new_color(&mut next_color)),
        };

        // 2. Lines coming in from above: every waiting lane converges into the node.
        for &i in &waiting {
            let lane = lanes[i].take().unwrap();
            segments.push(Segment {
                x1: i,
                y1: TOP,
                x2: col,
                y2: MID,
                color: lane.color,
            });
        }

        // 3. Lanes not involved with this commit pass straight through.
        for (i, lane) in lanes.iter().enumerate() {
            if let Some(l) = lane {
                segments.push(Segment {
                    x1: i,
                    y1: TOP,
                    x2: i,
                    y2: BOTTOM,
                    color: l.color,
                });
            }
        }

        // 4. Lines going out to parents.
        // The first parent always continues straight down this column, even when another
        // lane is already heading to it (those lanes converge when the parent is reached),
        // so a branch's main line stays put instead of drifting sideways.
        for (pi, parent) in commit.parents.iter().enumerate() {
            let (slot, lane_color) = if pi == 0 {
                (col, color)
            } else if let Some(i) = lanes.iter().position(|l| l.as_ref().is_some_and(|l| &l.sha == parent)) {
                // A merge parent another lane is already heading to: join that lane.
                let c = lanes[i].as_ref().unwrap().color;
                segments.push(Segment {
                    x1: col,
                    y1: MID,
                    x2: i,
                    y2: BOTTOM,
                    color: c,
                });
                continue;
            } else {
                (free_slot(&mut lanes), new_color(&mut next_color))
            };
            lanes[slot] = Some(Lane {
                sha: parent.clone(),
                color: lane_color,
            });
            segments.push(Segment {
                x1: col,
                y1: MID,
                x2: slot,
                y2: BOTTOM,
                color: lane_color,
            });
        }

        while matches!(lanes.last(), Some(None)) {
            lanes.pop();
        }
        width = width.max(lanes.len()).max(col + 1);
        rows.push(Row { commit, col, color, segments });
    }

    Graph { rows, width }
}

fn free_slot(lanes: &mut Vec<Option<Lane>>) -> usize {
    match lanes.iter().position(Option::is_none) {
        Some(i) => i,
        None => {
            lanes.push(None);
            lanes.len() - 1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(sha: &str, parents: &[&str]) -> Commit {
        Commit {
            sha: sha.into(),
            parents: parents.iter().map(|p| p.to_string()).collect(),
            author: String::new(),
            email: String::new(),
            time: 0,
            subject: String::new(),
            refs: Vec::new(),
            committer: None,
        }
    }

    #[test]
    fn linear_history_stays_in_one_column() {
        let g = layout(vec![c("c", &["b"]), c("b", &["a"]), c("a", &[])]);
        assert_eq!(g.width, 1);
        assert!(g.rows.iter().all(|r| r.col == 0));
        assert!(g.rows[2].segments.iter().all(|s| s.y2 != BOTTOM));
    }

    #[test]
    fn branch_and_merge_use_two_columns() {
        // m merges f into b; f and b both come from a.
        let g = layout(vec![c("m", &["b", "f"]), c("f", &["a"]), c("b", &["a"]), c("a", &[])]);
        assert_eq!(g.width, 2);
        assert_eq!(g.rows[0].col, 0);
        assert_eq!(g.rows[1].col, 1);
        assert_eq!(g.rows[2].col, 0);
        assert_eq!(g.rows[3].col, 0);
        // At `a`, the side lane converges back into column 0.
        assert!(g.rows[3].segments.contains(&Segment {
            x1: 1,
            y1: TOP,
            x2: 0,
            y2: MID,
            color: g.rows[1].color
        }));
    }

    #[test]
    fn independent_tips_get_their_own_columns() {
        let g = layout(vec![c("x", &["a"]), c("y", &["a"]), c("a", &[])]);
        assert_eq!(g.rows[0].col, 0);
        assert_eq!(g.rows[1].col, 1);
        assert_eq!(g.rows[2].col, 0);
        assert_ne!(g.rows[0].color, g.rows[1].color);
    }
}
