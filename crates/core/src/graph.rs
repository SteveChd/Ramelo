//! Layout of the commit graph: each commit gets a lane (column), and each row says which lines to
//! draw above and below its dot.
//!
//! Commits come newest first, children before parents. A lane « waits » for the next commit of its
//! line of history (the first parent of the commit above it); the other parents of a merge open new
//! lanes, or join the lane that already waits for them.

use serde::Serialize;

use crate::log::Commit;

/// A line drawn in one half of a row, from lane `from` (top or middle of the row) to lane `to`
/// (middle or bottom).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Edge {
    pub from: usize,
    pub to: usize,
    /// Colour index of the line of history (the interface picks the actual colour).
    pub color: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRow {
    /// Lane of the commit's dot.
    pub lane: usize,
    pub color: usize,
    /// Lines from the top of the row to its middle.
    pub top: Vec<Edge>,
    /// Lines from the middle of the row to its bottom.
    pub bottom: Vec<Edge>,
}

#[derive(Debug, Clone)]
struct Lane {
    /// Commit this lane waits for.
    oid: String,
    color: usize,
}

/// One row per commit, in the same order, and the number of lanes used (the graph's width).
pub fn layout(commits: &[Commit]) -> (Vec<GraphRow>, usize) {
    let mut lanes: Vec<Option<Lane>> = Vec::new();
    let mut next_color = 0;
    let mut width = 0;
    let mut rows = Vec::with_capacity(commits.len());

    let mut new_color = || {
        let color = next_color;
        next_color += 1;
        color
    };

    for commit in commits {
        // Lanes waiting for this commit: the first one carries the dot, the others merge into it.
        let waiting: Vec<usize> =
            lanes.iter().enumerate().filter(|(_, l)| l.as_ref().is_some_and(|l| l.oid == commit.oid)).map(|(i, _)| i).collect();
        let (lane, color) = match waiting.first() {
            Some(&i) => (i, lanes[i].as_ref().map_or(0, |l| l.color)),
            // A branch tip: a new line of history starts in the first free lane.
            None => (free_lane(&mut lanes), new_color()),
        };

        let top: Vec<Edge> = lanes
            .iter()
            .enumerate()
            .filter_map(|(i, l)| l.as_ref().map(|l| (i, l)))
            .map(|(i, l)| Edge { from: i, to: if l.oid == commit.oid { lane } else { i }, color: l.color })
            .collect();
        for &i in &waiting {
            lanes[i] = None;
        }

        // The commit's lane goes on with its first parent.
        let mut merges = Vec::new();
        let mut opened = Vec::new();
        if let Some(first) = commit.parents.first() {
            lanes[lane] = Some(Lane { oid: first.clone(), color });
        }
        for parent in commit.parents.iter().skip(1) {
            match lanes.iter().position(|l| l.as_ref().is_some_and(|l| &l.oid == parent)) {
                Some(i) => merges.push(Edge { from: lane, to: i, color: lanes[i].as_ref().map_or(0, |l| l.color) }),
                None => {
                    let i = free_lane(&mut lanes);
                    let color = new_color();
                    lanes[i] = Some(Lane { oid: parent.clone(), color });
                    opened.push(i);
                    merges.push(Edge { from: lane, to: i, color });
                }
            }
        }

        let mut bottom: Vec<Edge> = lanes
            .iter()
            .enumerate()
            .filter_map(|(i, l)| l.as_ref().map(|l| (i, l)))
            // A lane opened by this merge starts at the dot, with the merge line only.
            .filter(|(i, _)| !opened.contains(i))
            .map(|(i, l)| Edge { from: i, to: i, color: l.color })
            .collect();
        bottom.extend(merges);

        while lanes.last().is_some_and(Option::is_none) {
            lanes.pop();
        }
        width = width.max(lanes.len()).max(lane + 1);
        rows.push(GraphRow { lane, color, top, bottom });
    }
    (rows, width)
}

fn free_lane(lanes: &mut Vec<Option<Lane>>) -> usize {
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

    fn commit(oid: &str, parents: &[&str]) -> Commit {
        Commit {
            oid: oid.into(),
            parents: parents.iter().map(|p| (*p).into()).collect(),
            author: String::new(),
            email: String::new(),
            time: 0,
            summary: String::new(),
            refs: Vec::new(),
        }
    }

    fn lanes(rows: &[GraphRow]) -> Vec<usize> {
        rows.iter().map(|r| r.lane).collect()
    }

    #[test]
    fn a_straight_history_uses_one_lane() {
        let (rows, width) = layout(&[commit("c", &["b"]), commit("b", &["a"]), commit("a", &[])]);
        assert_eq!((lanes(&rows), width), (vec![0, 0, 0], 1));
        assert!(rows[0].top.is_empty());
        assert_eq!(rows[1].top, [Edge { from: 0, to: 0, color: 0 }]);
        assert!(rows[2].bottom.is_empty());
    }

    #[test]
    fn a_merge_opens_a_lane_that_closes_at_the_fork() {
        //   m        merge of b2 into a2
        //   |\
        //   a2 b2
        //   |  b1
        //   | /
        //   a1
        let commits = [
            commit("m", &["a2", "b2"]),
            commit("a2", &["a1"]),
            commit("b2", &["b1"]),
            commit("b1", &["a1"]),
            commit("a1", &[]),
        ];
        let (rows, width) = layout(&commits);
        assert_eq!((lanes(&rows), width), (vec![0, 0, 1, 1, 0], 2));
        // The merge commit draws a line down to the new lane.
        assert!(rows[0].bottom.contains(&Edge { from: 0, to: 1, color: 1 }));
        // At the fork, the side lane joins the main lane.
        assert!(rows[4].top.contains(&Edge { from: 1, to: 0, color: 1 }));
        assert_eq!(rows[4].color, 0);
    }

    #[test]
    fn two_branch_tips_get_their_own_lanes_and_colours() {
        let commits = [commit("x", &["base"]), commit("y", &["base"]), commit("base", &[])];
        let (rows, width) = layout(&commits);
        assert_eq!((lanes(&rows), width), (vec![0, 1, 0], 2));
        assert_ne!(rows[0].color, rows[1].color);
        // The second tip passes the first lane straight through.
        assert!(rows[1].top.contains(&Edge { from: 0, to: 0, color: rows[0].color }));
    }

    #[test]
    fn a_merge_into_a_lane_already_waiting_for_the_parent_does_not_open_one() {
        // y waits for base in lane 1 when m (merging base) is laid out.
        let commits = [commit("y", &["base"]), commit("m", &["a", "base"]), commit("a", &["base"]), commit("base", &[])];
        let (rows, width) = layout(&commits);
        assert_eq!(lanes(&rows), [0, 1, 1, 0]);
        assert_eq!(width, 2);
        assert!(rows[1].bottom.contains(&Edge { from: 1, to: 0, color: rows[0].color }));
    }
}
