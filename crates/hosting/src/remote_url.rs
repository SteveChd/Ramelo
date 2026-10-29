//! Where a remote of a repository points: the server, and the repository's path on it, whatever the
//! form of the address (https, ssh, « git@host:path »).

/// A remote address taken apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteLocation {
    /// Server name, without user or port (« github.com »).
    pub hostname: String,
    /// Path of the repository on the server, without « .git » nor slashes around (« owner/repo »).
    pub path: String,
}

pub fn parse(url: &str) -> Option<RemoteLocation> {
    let url = url.trim();
    let (authority, path) = if let Some((scheme, rest)) = url.split_once("://") {
        if !["http", "https", "ssh", "git", "git+ssh", "ssh+git"].contains(&scheme.to_ascii_lowercase().as_str()) {
            return None;
        }
        rest.split_once('/')?
    } else {
        // « git@host:owner/repo.git », the short form of ssh; a Windows path (« C:\… ») is not one.
        let (authority, path) = url.split_once(':')?;
        if authority.len() < 2 || authority.contains('/') || authority.contains('\\') {
            return None;
        }
        (authority, path)
    };
    let host = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
    let hostname = host.rsplit_once(':').map_or(host, |(name, _)| name).trim_matches(['[', ']']);
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path).trim_end_matches('/');
    if hostname.is_empty() || path.is_empty() {
        return None;
    }
    Some(RemoteLocation { hostname: hostname.to_ascii_lowercase(), path: path.to_owned() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(url: &str) -> (String, String) {
        let l = parse(url).unwrap_or_else(|| panic!("{url}"));
        (l.hostname, l.path)
    }

    #[test]
    fn reads_every_form_of_address() {
        let gh = ("github.com".to_owned(), "steve/ramelo".to_owned());
        assert_eq!(at("https://github.com/steve/ramelo.git"), gh);
        assert_eq!(at("https://steve@github.com/steve/ramelo/"), gh);
        assert_eq!(at("git@github.com:steve/ramelo.git"), gh);
        assert_eq!(at("ssh://git@GitHub.com:22/steve/ramelo"), gh);
        assert_eq!(at("https://gitlab.example.com:8443/group/sub/project.git"), ("gitlab.example.com".into(), "group/sub/project".into()));
        assert_eq!(at("ssh://git@bitbucket.example.com:7999/proj/repo.git"), ("bitbucket.example.com".into(), "proj/repo".into()));
        assert!(parse("C:\\Users\\steve\\repo").is_none());
        assert!(parse("/home/steve/repo").is_none());
        assert!(parse("file:///home/steve/repo").is_none());
        assert!(parse("https://github.com/").is_none());
    }
}
