export const EXAMPLES: Record<string, string> = {
  'Breaker Failure (SEL-751A)': `// Breaker failure logic with feedback seal-in
OPTION OUTPUT_ORDER = AUTO
OPTION INPUT_ORDER = AUTO

BFT = BFI OR BFT AND ((CB52A AND CB52ABFY) OR (I1I2 AND INOM))

BFI.Description = "Relay Word Bit"

CB52A.Name = "52A"
CB52ABFY.Name = "52ABF = Y"
CB52ABFY.Description = "Setting"

I1I2.Name = "$\\mathrm{|I1|+|I2|}$"
INOM.Name = "$\\mathrm{0.02 \\cdot I_{NOM}}$"

// SEL-751A Instruction Manual Figure 4.55 Breaker Failure Logic`,

  'SEL Function Blocks': `// SEL-style timer, SR latch, comparator and edge triggers
OPTION OUTPUT_ORDER = AUTO
A = SR(COMPARE(IA, IPICKUP), RESET)
TRIP = TIMER(A, 0, 30cyc)
ALARM = RISING(COMPARE(IA, IPICKUP))
RESTART = FALLING(BLOCK)`,

  'Labelled Gates': `// Name a gate by assigning it to an intermediate, then label it — the
// name/description appear at the gate's output and wires route around them.
OPTION OUTPUT_ORDER = AUTO
PH  = O51 OR O50 OR NEGSEQ
EF  = E51N OR E50N
HS  = O502 OR E50N2
SUP = PH AND NOT HBLK
TRIP = SUP OR EF OR HS
PH.Name = "Phase OC"
PH.Description = "51/50/46"
EF.Name = "Earth Fault"
EF.Description = "51N/50N"
HS.Name = "High-Set"
HS.Description = "50-2"
SUP.Name = "Supervised"
SUP.Description = "harmonic block"`,

  'Complex Protection (SEL)': `// SEL scheme exercising every block type with gate logic
OPTION OUTPUT_ORDER = AUTO

OC_TRIP = TIMER#TD(SR#TL(COMPARE#C50(IA, IPICKUP) AND NOT BLOCK, RESET), 2cyc, 0)
BF_TRIP = TIMER#BFT(COMPARE#C87(IDIFF, IREST) AND CB52A, 0, 12cyc)
ALARM = RISING(START) OR EXT_ALARM
RECLOSE = FALLING(CB52A) AND NOT LOCKOUT

C50.Name = "50P1"
C50.Description = "Phase OC"
C87.Name = "87"
C87.Description = "Differential"
TL.Name = "Trip Latch"
TD.Name = "62T"
TD.Description = "Trip delay"
BFT.Name = "62BF"
BFT.Description = "BF delay"`,

  'Shared Intermediates': `// Consumed intermediates: A is internal but labelled at its junction;
// B is forced to an output with .OUT = TRUE
OPTION OUTPUT_ORDER = AUTO
B = COMPARE(IA, IPICKUP)
A = SR(B, RESET) OR B OR C
TRIP = TIMER(A, 0, 30cyc)
ALARM = RISING(COMPARE(IA, IPICKUP))
A.Name = "Trip Permit"
A.Description = "Seal-in"
B.OUT = TRUE`,

  'Generic Block (FB)': `// Generic user block: instantiate once, bind multiple outputs via bare port assignment
OPTION OUTPUT_ORDER = AUTO
TRIP  = FB#PROT(PHASE=IA, EARTH=IN, EN=ENABLE).TRIP
ALARM = FB#PROT.ALARM
CLOSE = FB#PROT.CLOSE
PROT.Name = "Feeder Protection"
PROT.Description = "SEL-751A"`,

  'Named Gates': `// Direct gate naming with AND#ID(...) / OR#ID(...) — no pass-through intermediate needed
OPTION OUTPUT_ORDER = AUTO
OC = OR#OC1(I51, I50, I46)
OC1.Name = "Overcurrent"
OC1.Description = "51/50N"
TRIP = AND#TRIP1(OC, NOT BLOCK)
TRIP1.Name = "Trip AND"
TRIP1.Description = "permissive"
O1 = AND#GEN(A, B)
GEN.Name = "Combo Gate"
GEN.Description = "stage 1"`,

  'Simple AND Gate': `// Simple AND gate
OUT = A AND B`,

  'Simple OR Gate': `// Simple OR gate
OUT = A OR B`,

  'NOT Gate': `// NOT gate
OUT = NOT A`,

  'Combined Logic (CBFPS)': `// Protection logic for CBFPS
CBFPS = AB AND DC OR (NOT DC AND GF)`,

  'Trip Logic': `// Trip Logic: TRIP is a consumed intermediate (not shown); MAIN_TRIP is the output
TRIP = OVERCURRENT OR (NOT EARTH_FAULT)
MAIN_TRIP = TRIP AND (MANUAL_TRIP OR REMOTE_TRIP)`,

  'Three-Input AND': `// Three inputs into an AND gate
OUT = A AND B AND C`,

  'Triple OR': `// Three inputs into an OR gate
ALARM = TEMP OR PRESSURE OR FLOW`,

  'Nested NOT': `// Double negation
OUT = NOT NOT A`,

  'Complex Protection': `// Complex protection scheme
OPTION OUTPUT_ORDER = AUTO
TRIP_1 = OVERCURRENT_A OR OVERCURRENT_B
TRIP_2 = EARTH_FAULT AND NOT BLOCK
MAIN_TRIP = TRIP_1 AND TRIP_2`,

  'Mixed Logic': `// Mixed AND/OR with negation: RESULT is consumed (not shown), OUTPUT is the result
RESULT = (A AND B) OR (C AND NOT D)
OUTPUT = RESULT AND (ENABLE OR FORCE)`,

  'Interlocking Q01 Close': `// Interlocking Example for Collector Feeder Q01 (Close)

I1.Name = "CBQ 00 Open"
I1.Description = "(BI 3.1)"

I2.Name = "BB Not Earthed"
I2.Description = "(BI 3.24)"

I3.Name = "D/S Q01 Open"
I3.Description = "(BI 3.3)"

I4.Name = "E/S Q05 Open"
I4.Description = "(BI 3.5)"

I5.Name = "KF1 Release"
I5.Description = "(BI 3.15)"

I6.Name = "In Remote"
I6.Description = "(BI 3.11)"

I7.Name = "SCADA ON"
I7.Description = "(BI 3.23)"

I8.Name = "DNP Close Command"
I8.Description = "(via RTU)"

I9.Name = "In Local"
I9.Description = "(BI 3.12)"

I10.Name = "Close Switch"
I10.Description = "(BI 3.20)"

O1 = (I1 AND I2) AND (I3 AND I4 AND NOT I5) AND ((I6 AND I7 AND I8) OR (I9 AND I10))

O1.Name = "Output"
O1.Description = "(BO 3.2)"`,

  'Inversion Bubbles': `// Inversion Bubbles: NOT rendered as bubbles on gate inputs/outputs
OPTION INVERSION = BUBBLES

I1.Name = "Start Permitted"
I1.Description = "(BI 1.1)"
I2.Name = "Stop Condition"
I2.Description = "(BI 1.2)"
I3.Name = "Reset"
I3.Description = "(BI 1.3)"

O1 = I1 AND NOT I2 AND I3
O2 = NOT (I1 AND I3)
O3 = NOT I2
O4 = NOT NOT I3

O1.Name = "Run"
O1.Description = "(BO 1.1)"
O2.Name = "NAND Result"
O2.Description = "(BO 1.2)"
O3.Name = "Inverted Stop"
O3.Description = "(BO 1.3)"
O4.Name = "Pass-Through"
O4.Description = "(BO 1.4)"`,

  'Input Bars': `// Input Bars: multi-input gates stay at 2-input size
OPTION GATE_INPUT_STYLE = BARS

I1.Name = "Start"
I2.Name = "Stop"
I3.Name = "Reset"
I4.Name = "Enable"
I5.Name = "Supervision"

O1 = I1 AND I2 AND I3 AND I4 AND I5
O1.Name = "Output"`,

  'Square Ports': `// Square port markers
OPTION PORT_STYLE = SQUARE

A.Name = "Signal A"
B.Name = "Signal B"
O1 = A AND B
O1.Name = "Result"`,

  'Combined Options': `// Combined options: bubbles + bars + square ports
OPTION INVERSION = BUBBLES
OPTION GATE_INPUT_STYLE = BARS
OPTION PORT_STYLE = SQUARE

I1.Name = "Start"
I2.Name = "Stop"
I3.Name = "Reset"
I4.Name = "Enable"
I5.Name = "Supervision"
I6.Name = "Override"

O1 = (I1 AND NOT I2) AND (I3 AND I4 AND I5 AND I6)
O1.Name = "Master Trip"
O1.Description = "(BO 1.1)"`,

  'Overcurrent Protection': `// Overcurrent protection with math labels
OPTION OUTPUT_ORDER = AUTO
I1.Name = "$I_a$"
I1.Description = "Phase A current"

I2.Name = "$I_b$"
I2.Description = "Phase B current"

I3.Name = "$I_c$"
I3.Description = "Phase C current"

I4.Name = "$I_{set}$"
I4.Description = "Setting $= 5.0 \\$ A$"

O1.Name = "$I > I_{set}$"
O1.Description = "Overcurrent trip"

O2.Name = "$I_a + I_b + I_c$"
O2.Description = "Residual current"

O1 = I1 AND I4
O2 = I1 OR I2 OR I3`,

  'Differential Protection': `// Differential protection: $I_{diff} = I_{in} - I_{out}$

I1.Name = "$I_{in}$"
I1.Description = "CT primary current"

I2.Name = "$I_{out}$"
I2.Description = "CT secondary current"

I3.Name = "Block"
I3.Description = "Blocking signal"

O1.Name = "$I_{diff} > I_{bias}$"
O1.Description = "Differential trip"

O2.Name = "Restricted Earth Fault"
O2.Description = "$I_0 > I_{0\\_set}$"

O1 = (I1 AND NOT I2) AND NOT I3
O2 = NOT I3`,

  'Boolean Algebra': `// Boolean algebra with math notation
OPTION OUTPUT_ORDER = AUTO

A.Name = "$A$"
A.Description = "Input A"

B.Name = "$B$"
B.Description = "Input B"

C.Name = "$C$"
C.Description = "Input C"

O1.Name = "$A \\cdot B$"
O1.Description = "Logical AND"

O2.Name = "$A + B$"
O2.Description = "Logical OR"

O3.Name = "$\\overline{A}$"
O3.Description = "Logical NOT"

O4.Name = "$\\overline{A \\cdot B}$"
O4.Description = "NAND: $\\overline{AB}$"

O1 = A AND B
O2 = A OR B
O3 = NOT A
O4 = NOT (A AND B)`,

  'Motor Control Circuit': `// Motor starting circuit with math notation

I1.Name = "Start PB"
I1.Description = "$NO\\ contact$"

I2.Name = "Stop PB"
I2.Description = "$NC\\ contact$"

I3.Name = "OL Trip"
I3.Description = "$I^2 > I_{rated}^2$"

I4.Name = "Thermal"
I4.Description = "$\\Theta > \\Theta_{trip}$"

I5.Name = "$I_s$"
I5.Description = "Start current"

O1.Name = "Contactor"
O1.Description = "$K_1$"

O2.Name = "Trip"
O2.Description = "$\\Delta I > \\Delta I_{set}$"

OPTION INVERSION = BUBBLES

O1 = I1 AND NOT I2 AND NOT I3 AND NOT I4
O2 = I3 OR I4 OR NOT I5`,

  'Styled by ID': `// Reveal IDs in the toolbar, then click any element. Its SVG id (gate, input,
// output, wire, dot) is revealed so it can be styled or scripted.
//
// The STYLE block targets specific #ID groups emitted in the SVG output.
// AND#G1 -> SVG id "G1"; FB#P -> SVG id "P"; TRIP/O1 -> SVG ids "TRIP"/"O1".
//
// Toggle the Dots toolbar button to hide junction tie-points (item 11).
// Use the PNG dropdown for selectable-DPI raster export (item 13).
OPTION OUTPUT_ORDER = AUTO
OPTION HIDE_JUNCTIONS = FALSE

TRIP = AND#G1(START, INHIBIT, FB#P(BAND=IA, EARTH=IN, EN=BLK).TRIP)
ALARM = FB#P.ALARM

G1.Name = "Trip AND"
P.Name = "Feeder Protection"
P.Description = "SEL-751A"

STYLE
  #G1 .ldl-fill { fill: #fff3cd; }
  #P  { stroke: #1b5e20; }
  #TRIP { stroke: #c62828; stroke-width: 4; }
  #ALARM { stroke: #ef6c00; }
END STYLE`,

  'Hidden Dots': `// OPTION HIDE_JUNCTIONS hides every junction dot on the diagram (the toolbar
// Dots button flips the same flag on top of the source option). Useful when
// printing or when the wiring/junction pattern is visually noisy.
OPTION HIDE_JUNCTIONS = TRUE
OPTION INVERSION = BUBBLES
A = A1 OR A2 OR A3
B = B1 AND B2 AND B3
O = A AND B AND C`,
};

export const EXAMPLE_NAMES = Object.keys(EXAMPLES);