use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

use serde_json::json;

use super::crypto::{make_new_password, obfuscate_auth, RECONNECT_MARKER};
use super::framing::{build_message, drain_messages, MsgType, ParsedMessage, MAX_U32};
use super::session::{save_session, SessionData};
use crate::color::{hsl_to_rgb, hsv_to_rgb, rgb_to_hsv};

pub struct CSPConnection {
    pub host: String,
    pub port: u16,
    pub password: String,
    pub generation: String,
    pub reconnect_mode: bool,

    sock: Option<TcpStream>,
    serial: u32,
    recv_buffer: Vec<u8>,
    pub connected: bool,
    last_rgb: Option<(u8, u8, u8)>,
    /// 0 = main (foreground), 1 = sub (background). Tracks which slot CSP
    /// currently has selected so writes target the right one.
    current_color_index: u8,
    color_circle_uses_hls: bool,
}

impl CSPConnection {
    pub fn new(
        host: String,
        port: u16,
        password: String,
        generation: String,
        reconnect: bool,
    ) -> Self {
        Self {
            host,
            port,
            password,
            generation,
            reconnect_mode: reconnect,
            sock: None,
            serial: 0,
            recv_buffer: Vec::new(),
            connected: false,
            last_rgb: None,
            current_color_index: 0,
            color_circle_uses_hls: false,
        }
    }

    pub fn color_index(&self) -> u8 {
        self.current_color_index
    }

    pub fn connect(&mut self) -> Result<(), String> {
        let addr = format!("{}:{}", self.host, self.port);
        println!("[CSP] Connecting to {addr}...");
        let sock = TcpStream::connect_timeout(
            &addr.parse().map_err(|e| format!("bad addr: {e}"))?,
            Duration::from_secs(5),
        )
        .map_err(|e| format!("connect: {e}"))?;
        sock.set_read_timeout(Some(Duration::from_secs(5)))
            .map_err(|e| format!("set_read_timeout: {e}"))?;
        self.sock = Some(sock);
        self.connected = true;
        println!("[CSP] Connected!");
        self.authenticate()
    }

    fn authenticate(&mut self) -> Result<(), String> {
        // Reconnect: curr = obfuscated marker, new = same password we sent last time.
        // Fresh:     curr = obfuscated QR password, new = fresh random.
        let (curr_token, new_pass) = if self.reconnect_mode {
            (obfuscate_auth(RECONNECT_MARKER), self.password.clone())
        } else {
            (obfuscate_auth(&self.password), make_new_password())
        };
        let new_token = obfuscate_auth(&new_pass);
        let detail = serde_json::to_string(&[&self.generation, &curr_token, &new_token]).unwrap();

        let resp = self.send_command("Authenticate", &detail);
        match resp {
            Some(ref m) if m.msg_type == MsgType::Success => {
                self.password = new_pass;
                let server = m
                    .detail
                    .get("RemoteCommandSpecVersionOfServer")
                    .and_then(|v| v.as_str())
                    .unwrap_or("?");
                println!("[CSP] Authenticated! Server: {server}");
                save_session(&SessionData {
                    host: self.host.clone(),
                    port: self.port,
                    password: self.password.clone(),
                    generation: self.generation.clone(),
                });
                self.activate();
                Ok(())
            }
            _ => {
                self.connected = false;
                Err(format!("auth failed: {resp:?}"))
            }
        }
    }

    fn activate(&mut self) {
        // Mirror the Python activation ritual.
        let _ = self.send_command("TellHeartbeat", r#"{"IdleTimerResetRequested":true}"#);
        let _ = self.send_command(
            "GetModifyKeyString",
            r#"{"CtrlPushed":false,"AltPushed":false,"ShiftPushed":false}"#,
        );
        let _ = self.send_command("GetServerSelectedTabKind", "");
        let _ = self.send_command("SetServerSelectedTabKind", "");
        let _ = self.send_command("TellHeartbeat", r#"{"IdleTimerResetRequested":true}"#);
    }

    pub fn send_command(&mut self, command: &str, detail: &str) -> Option<ParsedMessage> {
        self.send_command_with_timeout(command, detail, Duration::from_secs(3))
    }

    fn send_command_with_timeout(
        &mut self,
        command: &str,
        detail: &str,
        timeout: Duration,
    ) -> Option<ParsedMessage> {
        if !self.connected && command != "Authenticate" {
            return None;
        }
        let s = self.serial;
        self.serial += 1;
        let msg = build_message(command, s, detail);
        if let Some(sock) = self.sock.as_mut() {
            if let Err(e) = sock.write_all(&msg) {
                eprintln!("[CSP] Send error: {e}");
                self.connected = false;
                return None;
            }
        } else {
            return None;
        }
        self.read_response(s, timeout)
    }

    fn read_response(&mut self, expected: u32, timeout: Duration) -> Option<ParsedMessage> {
        let deadline = Instant::now() + timeout;
        loop {
            // Check already-buffered messages first.
            let msgs = drain_messages(&mut self.recv_buffer);
            let mut reply = None;
            for m in msgs {
                let _ = self.absorb_color(&m);
                if m.serial as u32 == expected
                    && matches!(m.msg_type, MsgType::Success | MsgType::Error)
                {
                    reply = Some(m);
                }
            }
            if reply.is_some() {
                return reply;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return None;
            }
            let sock = self.sock.as_mut()?;
            sock.set_read_timeout(Some(remaining.max(Duration::from_millis(50))))
                .ok();
            let mut buf = [0u8; 8192];
            match sock.read(&mut buf) {
                Ok(0) => {
                    self.connected = false;
                    return None;
                }
                Ok(n) => {
                    self.recv_buffer.extend_from_slice(&buf[..n]);
                }
                Err(e)
                    if e.kind() == std::io::ErrorKind::WouldBlock
                        || e.kind() == std::io::ErrorKind::TimedOut =>
                {
                    continue;
                }
                Err(_) => {
                    self.connected = false;
                    return None;
                }
            }
        }
    }

    fn absorb_color(&mut self, m: &ParsedMessage) -> Option<(u8, u8, u8)> {
        let d = &m.detail;
        if !d.is_object() {
            return None;
        }
        // Track which slot CSP currently has selected so writes target it.
        if let Some(index @ 0..=1) = d.get("CurrentColorIndex").and_then(|x| x.as_u64()) {
            let index = index as u8;
            if self.current_color_index != index {
                self.last_rgb = None;
                self.current_color_index = index;
            }
        }
        let slot_prefix = if self.current_color_index == 1 {
            "Sub"
        } else {
            "Main"
        };
        let channel = |name: &str| d.get(name)?.as_u64().map(|v| v as f64 / MAX_U32);
        let hsv = |prefix: &str| {
            Some(hsv_to_rgb(
                channel(&format!("HSVColor{prefix}H"))?,
                channel(&format!("HSVColor{prefix}S"))?,
                channel(&format!("HSVColor{prefix}V"))?,
            ))
        };
        // CSP uses the HLS wire name when the color circle is in HSL mode.
        let hls = || {
            Some(hsl_to_rgb(
                channel(&format!("HLSColor{slot_prefix}H"))?,
                channel(&format!("HLSColor{slot_prefix}S"))?,
                channel(&format!("HLSColor{slot_prefix}L"))?,
            ))
        };
        let model = d.get("ColorSelectionModel").and_then(|v| v.as_str());
        if m.command == "SyncColorCircleUIState" && m.msg_type != MsgType::Error {
            match model {
                Some("HSV") => self.color_circle_uses_hls = false,
                Some("HLS") => self.color_circle_uses_hls = true,
                _ => {}
            }
        }
        let selected = match model {
            Some("HLS") => hls(),
            Some("HSV") => hsv(slot_prefix),
            _ => hsv(slot_prefix).or_else(hls),
        };
        // The unprefixed HSV form exists in some CSP updates, but it must not
        // substitute for missing Main/Sub data when the active slot is known.
        let selected = selected.or_else(|| {
            if d.get("CurrentColorIndex")
                .and_then(|v| v.as_u64())
                .is_none()
            {
                hsv("")
            } else {
                None
            }
        });
        let Some((r, g, b)) = selected else {
            return None;
        };
        let rgb = (
            (r * 255.0).round().clamp(0.0, 255.0) as u8,
            (g * 255.0).round().clamp(0.0, 255.0) as u8,
            (b * 255.0).round().clamp(0.0, 255.0) as u8,
        );
        self.last_rgb = Some(rgb);
        Some(rgb)
    }

    pub fn get_color_rgb(&mut self) -> Option<(u8, u8, u8)> {
        self.sample_color(Duration::from_secs(3)).ok()
    }

    pub fn poll_color_rgb(&mut self) -> Result<(u8, u8, u8), &'static str> {
        self.sample_color(Duration::from_millis(250))
    }

    fn sample_color(&mut self, timeout: Duration) -> Result<(u8, u8, u8), &'static str> {
        // Stale-state trick from PROTOCOL.md so server returns full detail.
        let stale = r#"{"IsManipulating":false,"HSVColorMainH":0,"HSVColorMainS":0,"HSVColorMainV":0,"CurrentColorIndex":0,"ColorSelectionModel":"HSV"}"#;
        // The cache is useful for passive updates, but it is not evidence that
        // this explicit sample succeeded. Never return a previous selection.
        self.last_rgb = None;
        let Some(response) =
            self.send_command_with_timeout("SyncColorCircleUIState", stale, timeout)
        else {
            let reason = if self.connected {
                "CSP color response timed out or connection closed"
            } else {
                "CSP disconnected before the color response"
            };
            return Err(reason);
        };
        if response.msg_type != MsgType::Success {
            return Err("CSP rejected the color sync request");
        }

        // read_response also absorbs pushed messages. Re-decode only the
        // matching Sync response so an older buffered update cannot satisfy
        // this sample.
        self.last_rgb = None;
        if !matches!(response.detail["CurrentColorIndex"].as_u64(), Some(0 | 1)) {
            return Err("CSP color response did not contain the current color slot");
        }
        self.absorb_color(&response)
            .ok_or("CSP color response did not contain a complete color")
    }

    pub fn set_color_hex(&mut self, hex: &str) -> Option<ParsedMessage> {
        self.set_color_hex_with_hue(hex, None)
    }

    pub fn set_color_hex_with_hue(
        &mut self,
        hex: &str,
        preserved_hue: Option<f64>,
    ) -> Option<ParsedMessage> {
        let hx = hex.trim_start_matches('#');
        if hx.len() < 6 {
            return None;
        }
        let r = u8::from_str_radix(&hx[0..2], 16).ok()? as f64 / 255.0;
        let g = u8::from_str_radix(&hx[2..4], 16).ok()? as f64 / 255.0;
        let b = u8::from_str_radix(&hx[4..6], 16).ok()? as f64 / 255.0;
        self.last_rgb = Some(((r * 255.0) as u8, (g * 255.0) as u8, (b * 255.0) as u8));
        let (calculated_hue, s, v) = rgb_to_hsv(r, g, b);
        let preserved_hue = preserved_hue.filter(|hue| hue.is_finite() && (0.0..1.0).contains(hue));
        let h = (preserved_hue.unwrap_or(calculated_hue) * MAX_U32) as u64;
        let level = (v * MAX_U32) as u64;
        // The HLS desktop wheel displays hue zero after an achromatic HSV
        // write, even when Companion readback retains the transmitted hue.
        let detail = if self.color_circle_uses_hls && s == 0.0 && preserved_hue.is_some() {
            json!({
                "ColorSpaceKind": "HLS",
                "IsColorTransparent": false,
                "HLSColorH": h,
                "HLSColorL": level,
                "HLSColorS": 0,
                "ColorIndex": self.current_color_index,
            })
        } else {
            json!({
                "ColorSpaceKind": "HSV",
                "IsColorTransparent": false,
                "HSVColorH": h,
                "HSVColorS": (s * MAX_U32) as u64,
                "HSVColorV": level,
                "ColorIndex": self.current_color_index,
            })
        };
        let response = self.send_command("SetCurrentColor", &detail.to_string());
        if response.is_none() {
            let reason = if self.connected {
                "no response"
            } else {
                "connection lost"
            };
            eprintln!("[CSP] SetCurrentColor failed: {reason}");
        }
        response
    }

    pub fn heartbeat(&mut self) {
        if !self.connected {
            return;
        }
        let _ = self.send_command("TellHeartbeat", r#"{"IdleTimerResetRequested":true}"#);
    }

    pub fn disconnect(&mut self) {
        self.connected = false;
        if let Some(sock) = self.sock.take() {
            let _ = sock.shutdown(std::net::Shutdown::Both);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;

    #[test]
    fn sampling_reads_the_selected_hls_color_instead_of_the_previous_hsv_color() {
        let mut connection =
            CSPConnection::new("127.0.0.1".into(), 0, String::new(), String::new(), false);
        let absorb = |connection: &mut CSPConnection, detail| {
            let _ = connection.absorb_color(&ParsedMessage {
                msg_type: MsgType::Success,
                command: "SyncColorCircleUIState".into(),
                serial: 0,
                detail,
            });
        };
        absorb(
            &mut connection,
            json!({"HSVColorH": 0, "HSVColorS": 4294967295_u32, "HSVColorV": 4294967295_u32}),
        );
        assert_eq!(connection.last_rgb, Some((255, 0, 0)));

        let mut hls = json!({
            "ColorSelectionModel": "HLS",
            "CurrentColorIndex": 0,
            "HLSColorMainH": 2588747411_u32,
            "HLSColorMainL": 2198012674_u32,
            "HLSColorMainS": 1259167119_u32,
            "HLSColorSubH": 0,
            "HLSColorSubL": 2147483648_u32,
            "HLSColorSubS": 0
        });
        absorb(&mut connection, hls.clone());
        assert_eq!(connection.last_rgb, Some((94, 122, 167)));

        hls["CurrentColorIndex"] = json!(1);
        absorb(&mut connection, hls);
        assert_eq!(connection.color_index(), 1);
        assert_eq!(connection.last_rgb, Some((128, 128, 128)));
    }

    #[test]
    fn set_color_uses_active_slot_even_if_slot_update_follows_ack() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let socket = TcpStream::connect(address).unwrap();
        let server = std::thread::spawn(move || {
            let (socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut peer = BufReader::new(socket);
            for (serial, slot, hue) in [(0, 0, 0), (1, 1, (MAX_U32 / 3.0) as u64)] {
                let mut raw = Vec::new();
                peer.read_until(0, &mut raw).unwrap();
                let request = drain_messages(&mut raw).pop().unwrap();
                assert_eq!(request.command, "SetCurrentColor");
                assert_eq!(request.serial, serial);
                assert_eq!(request.detail["ColorIndex"], slot);
                assert_eq!(request.detail["HSVColorH"], hue);
                let mut ack = build_message("SetCurrentColor", serial as u32, "{}");
                ack[0] = 0x06;
                if serial == 0 {
                    ack.extend(build_message(
                        "SyncColorCircleUIState",
                        0,
                        r#"{"CurrentColorIndex":1}"#,
                    ));
                }
                peer.get_mut().write_all(&ack).unwrap();
            }
        });

        let mut connection = CSPConnection::new(
            "127.0.0.1".into(),
            address.port(),
            String::new(),
            String::new(),
            false,
        );
        connection.sock = Some(socket);
        connection.connected = true;
        assert_eq!(
            connection.set_color_hex("#ff0000").unwrap().msg_type,
            MsgType::Success
        );
        // TCP may split the push from the first ACK. Wait for both records
        // before checking how a coalesced read affects the next command.
        if connection.color_index() == 0 {
            let _ = connection.read_response(u32::MAX, Duration::from_millis(50));
        }
        assert_eq!(connection.color_index(), 1);
        assert_eq!(
            connection.set_color_hex("#00ff00").unwrap().msg_type,
            MsgType::Success
        );
        server.join().unwrap();
    }

    #[test]
    fn circle_color_write_keeps_its_hue_when_rgb_is_achromatic() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let socket = TcpStream::connect(address).unwrap();
        let server = std::thread::spawn(move || {
            let (socket, _) = listener.accept().unwrap();
            let mut peer = BufReader::new(socket);
            let mut raw = Vec::new();
            peer.read_until(0, &mut raw).unwrap();
            let request = drain_messages(&mut raw).pop().unwrap();
            assert_eq!(request.command, "SetCurrentColor");
            assert_eq!(request.detail["HSVColorS"], 0);
            assert_eq!(
                request.detail["HSVColorH"],
                (120.0 / 360.0 * MAX_U32) as u64
            );
            assert_eq!(
                request.detail["HSVColorV"],
                (128.0 / 255.0 * MAX_U32) as u64
            );
            let mut response = build_message("SetCurrentColor", request.serial as u32, "{}");
            response[0] = 0x06;
            peer.get_mut().write_all(&response).unwrap();
        });
        let mut connection = CSPConnection::new(
            "127.0.0.1".into(),
            address.port(),
            String::new(),
            String::new(),
            false,
        );
        connection.sock = Some(socket);
        connection.connected = true;
        assert_eq!(
            connection
                .set_color_hex_with_hue("#808080", Some(120.0 / 360.0))
                .unwrap()
                .msg_type,
            MsgType::Success
        );
        server.join().unwrap();
    }

    #[test]
    fn achromatic_circle_write_matches_csp_model_and_keeps_its_slot() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let socket = TcpStream::connect(address).unwrap();
        let hue = (MAX_U32 / 3.0) as u64;
        let gray_level = (128.0 / 255.0 * MAX_U32) as u64;
        let server = std::thread::spawn(move || {
            let (socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut peer = BufReader::new(socket);
            let expected = [
                json!({"ColorSpaceKind":"HLS", "IsColorTransparent":false, "ColorIndex":1,
                       "HLSColorH":hue, "HLSColorL":gray_level, "HLSColorS":0}),
                json!({"ColorSpaceKind":"HSV", "IsColorTransparent":false, "ColorIndex":1,
                       "HSVColorH":0, "HSVColorS":0, "HSVColorV":gray_level}),
                json!({"ColorSpaceKind":"HSV", "IsColorTransparent":false, "ColorIndex":1,
                       "HSVColorH":hue, "HSVColorS":MAX_U32 as u64, "HSVColorV":MAX_U32 as u64}),
                json!({"ColorSpaceKind":"HSV", "IsColorTransparent":false, "ColorIndex":1,
                       "HSVColorH":hue, "HSVColorS":0, "HSVColorV":gray_level}),
            ];
            for (serial, detail) in expected.into_iter().enumerate() {
                let mut raw = Vec::new();
                peer.read_until(0, &mut raw).unwrap();
                let request = drain_messages(&mut raw).pop().unwrap();
                assert_eq!(request.command, "SetCurrentColor");
                assert_eq!(request.detail, detail);
                let mut ack = build_message("SetCurrentColor", serial as u32, "{}");
                ack[0] = 0x06;
                peer.get_mut().write_all(&ack).unwrap();
            }
        });

        let mut connection = CSPConnection::new(
            "127.0.0.1".into(),
            address.port(),
            String::new(),
            String::new(),
            false,
        );
        connection.sock = Some(socket);
        connection.connected = true;
        let set_model = |connection: &mut CSPConnection, model| {
            connection.absorb_color(&ParsedMessage {
                msg_type: MsgType::Success,
                command: "SyncColorCircleUIState".into(),
                serial: 0,
                detail: json!({"ColorSelectionModel": model, "CurrentColorIndex": 1}),
            });
        };
        let green = Some(1.0 / 3.0);
        set_model(&mut connection, "HLS");
        assert!(connection.set_color_hex_with_hue("#808080", green).is_some());
        assert!(connection.set_color_hex("#808080").is_some());
        assert!(connection.set_color_hex_with_hue("#00ff00", green).is_some());
        set_model(&mut connection, "HSV");
        assert!(connection.set_color_hex_with_hue("#808080", green).is_some());
        server.join().unwrap();
    }

    #[test]
    fn ordinary_color_write_still_derives_hue_from_rgb() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let socket = TcpStream::connect(address).unwrap();
        let server = std::thread::spawn(move || {
            let (socket, _) = listener.accept().unwrap();
            let mut peer = BufReader::new(socket);
            let mut raw = Vec::new();
            peer.read_until(0, &mut raw).unwrap();
            let request = drain_messages(&mut raw).pop().unwrap();
            assert_eq!(request.detail["HSVColorH"], 0);
            let mut response = build_message("SetCurrentColor", request.serial as u32, "{}");
            response[0] = 0x06;
            peer.get_mut().write_all(&response).unwrap();
        });
        let mut connection = CSPConnection::new(
            "127.0.0.1".into(),
            address.port(),
            String::new(),
            String::new(),
            false,
        );
        connection.sock = Some(socket);
        connection.connected = true;
        assert_eq!(
            connection.set_color_hex("#808080").unwrap().msg_type,
            MsgType::Success
        );
        server.join().unwrap();
    }
    #[test]
    fn failed_sampling_does_not_report_the_previous_cached_color() {
        let mut connection =
            CSPConnection::new("127.0.0.1".into(), 0, String::new(), String::new(), false);
        connection.last_rgb = Some((94, 122, 167));

        assert_eq!(connection.get_color_rgb(), None);
    }
    fn mock_color_sample(detail: serde_json::Value, response_type: u8) -> Option<(u8, u8, u8)> {
        mock_color_read(detail, response_type, false)
    }

    fn mock_color_read(
        detail: serde_json::Value,
        response_type: u8,
        passive: bool,
    ) -> Option<(u8, u8, u8)> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let socket = TcpStream::connect(address).unwrap();
        let server = std::thread::spawn(move || {
            let (socket, _) = listener.accept().unwrap();
            let mut peer = BufReader::new(socket);
            let mut raw = Vec::new();
            peer.read_until(0, &mut raw).unwrap();
            let request = drain_messages(&mut raw).pop().unwrap();
            assert_eq!(request.command, "SyncColorCircleUIState");
            let mut response = build_message(
                "SyncColorCircleUIState",
                request.serial as u32,
                &detail.to_string(),
            );
            response[0] = response_type;
            if passive {
                let mut old = build_message(
                    "SyncColorCircleUIState",
                    request.serial as u32 + 10,
                    r#"{"CurrentColorIndex":0,"HSVColorMainH":0,"HSVColorMainS":0,"HSVColorMainV":0}"#,
                );
                old[0] = 0x06;
                old.append(&mut response);
                response = old;
            }
            peer.get_mut().write_all(&response).unwrap();
        });

        let mut connection = CSPConnection::new(
            "127.0.0.1".into(),
            address.port(),
            String::new(),
            String::new(),
            false,
        );
        connection.sock = Some(socket);
        connection.connected = true;
        connection.last_rgb = Some((94, 122, 167));
        let result = if passive {
            connection.poll_color_rgb().ok()
        } else {
            connection.get_color_rgb()
        };
        server.join().unwrap();
        result
    }

    #[test]
    fn passive_color_read_requires_a_fresh_response_and_an_explicit_slot() {
        assert_eq!(mock_color_read(json!({}), 0x06, true), None);
        assert_eq!(
            mock_color_read(
                json!({"HSVColorMainH":0,"HSVColorMainS":0,"HSVColorMainV":0}),
                0x06,
                true,
            ),
            None
        );
        assert_eq!(
            mock_color_read(
                json!({
                    "CurrentColorIndex": 1,
                    "ColorSelectionModel": "HLS",
                    "HLSColorSubH": 0,
                    "HLSColorSubS": 4294967295_u32,
                    "HLSColorSubL": 2147483647_u32
                }),
                0x06,
                true,
            ),
            Some((255, 0, 0))
        );
    }

    #[test]
    fn sampling_requires_success_and_complete_selected_slot_data() {
        assert_eq!(
            mock_color_sample(json!({"CurrentColorIndex": 0}), 0x06),
            None
        );
        assert_eq!(
            mock_color_sample(
                json!({
                    "CurrentColorIndex": 0,
                    "ColorSelectionModel": "HSV",
                    "HSVColorMainH": 0,
                    "HSVColorMainS": 4294967295_u32,
                    "HSVColorMainV": 4294967295_u32
                }),
                0x15
            ),
            None
        );
        assert_eq!(
            mock_color_sample(
                json!({
                    "CurrentColorIndex": 1,
                    "ColorSelectionModel": "HSV",
                    "HSVColorMainH": 0,
                    "HSVColorMainS": 4294967295_u32,
                    "HSVColorMainV": 4294967295_u32,
                    "HSVColorSubH": 2863311530_u32,
                    "HSVColorSubS": 4294967295_u32,
                    "HSVColorSubV": 4294967295_u32
                }),
                0x06
            ),
            Some((0, 0, 255))
        );
        assert_eq!(
            mock_color_sample(
                json!({
                    "CurrentColorIndex": 1,
                    "ColorSelectionModel": "HSV",
                    "HSVColorH": 0,
                    "HSVColorS": 4294967295_u32,
                    "HSVColorV": 4294967295_u32
                }),
                0x06
            ),
            None
        );
        assert_eq!(
            mock_color_sample(
                json!({
                    "CurrentColorIndex": 1,
                    "ColorSelectionModel": "HLS",
                    "HLSColorMainH": 0,
                    "HLSColorMainS": 4294967295_u32,
                    "HLSColorMainL": 2147483648_u32,
                    "HLSColorSubH": 0,
                    "HLSColorSubS": 0,
                    "HLSColorSubL": 2147483648_u32
                }),
                0x06
            ),
            Some((128, 128, 128))
        );
    }
}
