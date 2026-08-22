use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Request {
    Ping,
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Response {
    Pong,
    Accepted,
    Error { message: String },
}

#[cfg(test)]
mod tests {
    use super::{Request, Response};

    #[test]
    fn protocol_messages_round_trip_as_json() {
        let request = serde_json::to_string(&Request::Ping).expect("request serializes");
        assert_eq!(serde_json::from_str::<Request>(&request).unwrap(), Request::Ping);

        let response = serde_json::to_string(&Response::Pong).expect("response serializes");
        assert_eq!(serde_json::from_str::<Response>(&response).unwrap(), Response::Pong);
    }
}
