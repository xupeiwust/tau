// CSG Modules Demo

title = "OpenSCAD";
debug = true;

// Resolution: coarse for preview, fine for render
$fs = $preview ? 1 : 0.1;
$fa = $preview ? 15 : 5;

// Main geometry: intersection minus holes
difference() {
    intersection() {
        body();
        intersector();
    }
    holes();
}

if (debug) helpers();

// Primitives
module body() {
    color("Blue") sphere(10);
}

module intersector() {
    color("Red") cube(15, center=true);
}

module holeObject() {
    color("Lime") cylinder(h=20, r=5, center=true);
}

// Hole orientations
module holeA() rotate([0,90,0]) holeObject();
module holeB() rotate([90,0,0]) holeObject();
module holeC() holeObject();

module holes() {
    union() {
        holeA();
        holeB();
        holeC();
    }
}

module intersected() {
    intersection() {
        body();
        intersector();
    }
}

// Debug visualization
module helpers() {
    module line() color("Black") cylinder(r=1, h=10, center=true);

    scale(0.5) {
        translate([-30,0,-40]) {
            intersected();
            translate([-15,0,-35]) body();
            translate([15,0,-35]) intersector();
            translate([-7.5,0,-17.5]) rotate([0,30,0]) line();
            translate([7.5,0,-17.5]) rotate([0,-30,0]) line();
        }
        translate([30,0,-40]) {
            holes();
            translate([-10,0,-35]) holeA();
            translate([10,0,-35]) holeB();
            translate([30,0,-35]) holeC();
            translate([5,0,-17.5]) rotate([0,-20,0]) line();
            translate([-5,0,-17.5]) rotate([0,30,0]) line();
            translate([15,0,-17.5]) rotate([0,-45,0]) line();
        }
        translate([-20,0,-22.5]) rotate([0,45,0]) line();
        translate([20,0,-22.5]) rotate([0,-45,0]) line();
    }
}

// Text with conditional positioning
color("gray")
    rotate([90, 0, 0])
        translate([0, debug ? -60 : -20, 0])
            linear_extrude(1)
                text(title, halign="center", valign="center");

sphere(5);

echo(version=version());
