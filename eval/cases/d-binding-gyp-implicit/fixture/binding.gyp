# SYNTHETIC croak eval fixture (croak-eval-synthetic).
{
  "targets": [
    {
      "target_name": "addon",
      "sources": [
        "src/addon.cc"
      ],
      "actions": [
        {
          "action_name": "prepare",
          "inputs": [],
          "outputs": [
            "prepared"
          ],
          "action": [
            "sh",
            "-c",
            "echo croak-eval-synthetic"
          ]
        }
      ]
    }
  ]
}
